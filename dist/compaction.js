import { createRequire } from "node:module";
import { existsSync, globSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

//#region src/shared/types.ts
/** 终态集合：无出边，进入后任何写操作都走非法迁移。 */
const TERMINAL_STATUSES = [
	"completed",
	"cancelled",
	"failed"
];
/** 终态判定。 */
function isTerminal(status) {
	return TERMINAL_STATUSES.includes(status);
}

//#endregion
//#region src/host/compaction/task-summary.ts
/** 无活跃任务时的兜底句（引擎要求摘要至少一块非空文本）。 */
const IDLE_LINE = "当前没有进行中的任务。";
/** 一条任务的描述行（紧凑单行；与任务简述 taskBrief 同一信息密度）。 */
function describeTask(record) {
	const parts = [`【${record.status}】${record.id}「${record.title}」目标：${record.goal}`];
	if (record.acceptance.length > 0) parts.push(`验收要点：${record.acceptance.join("；")}`);
	if (record.constraints.length > 0) parts.push(`约束：${record.constraints.join("；")}`);
	return parts.join("；");
}
/**
* 装配任务描述清单文本：终态剔除、按 id 升序各一行；空集给兜底句。
*/
function assembleTaskSummary(records) {
	const ordered = records.filter((record) => !isTerminal(record.status)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	if (ordered.length === 0) return IDLE_LINE;
	return ordered.map(describeTask).join("\n");
}
/**
* 选出该会话派发的任务（终态与否交给装配函数裁决）。「别的会话派的不归我」
* 定在这一个选择器里；真引擎与测试共用。
*/
function selectDispatchedBy(records, sessionId) {
	return records.filter((record) => record.dispatchedBySessionId === sessionId);
}
/**
* 账本驱动的 summarize 判断（真引擎与测试驱动器共用同一套逻辑）：
* 该会话派发且有活跃任务 → 装配描述文本，provider/model 标「router-ledger」/
* 「task-summary」，不置 llmStreamCall（描述装配不调 LLM）；
* 账本不可用 / 无活跃任务 / 会话标识缺失 → 回退默认 summarize。
*/
async function taskSummarySummarize(records, fallback, input, agent, signal) {
	const sessionId = agent?.session?.id;
	if (records === void 0 || sessionId === void 0) return fallback(input, agent, signal);
	const mine = selectDispatchedBy(records, sessionId);
	if (!mine.some((record) => !isTerminal(record.status))) return fallback(input, agent, signal);
	return {
		summary: [{
			type: "text",
			text: assembleTaskSummary(mine)
		}],
		provider: "router-ledger",
		model: "task-summary"
	};
}

//#endregion
//#region src/host/presets/validate-row.ts
/**
* 全部宿主安装目录探测（多基准版）：DSH_HOST_BASE（设了就只用它）→ 桌面 asar →
* ~/.local/share / nvm / homebrew 的 CLI 安装。桌面 asar 只有 Electron 进程读得
* 进，纯 node 进程 import 会失败——所以运行时校验要按序逐个试（makeHostLoader
* 的 bases 参数），不能只取第一个。
*/
function discoverAllHostBases() {
	const override = process.env.DSH_HOST_BASE;
	if (override !== void 0 && override !== "" && existsSync(override)) return [override];
	const bases = [];
	if (process.platform === "darwin") {
		const asar = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json";
		if (existsSync(asar)) bases.push(asar);
	}
	const home = homedir();
	for (const pattern of [
		join(home, ".local/share/node-*/lib/node_modules/@deepseek-ai/dsh/package.json"),
		join(home, ".nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh/package.json"),
		"/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json",
		"/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json"
	]) for (const hit of globSync(pattern)) if (existsSync(hit) && !bases.includes(hit)) bases.push(hit);
	return bases;
}
/**
* 宿主安装目录装载器（脚本与运行时共用同一份解析语义）：
*  - `@deepseek-ai/*` 行从宿主基准解析；
*  - 其他行（本包自己的子路径导出）先试插件根（Node 自引用），再退宿主基准；
*  - 用 import() 而非 require()：宿主加载器走 import，插件 ESM 图有 top-level
*    await，require 会在插件行上炸 ERR_REQUIRE_ASYNC_MODULE（容器核查器同规则）。
* 全部候选失败时抛第一条错误（最贴近插件自己那份解析，报错才有指向性）。
*/
function makeHostLoader(opts = {}) {
	const pluginRoot = opts.pluginRoot ?? fileURLToPath(new URL("../../../", import.meta.url));
	const candidatesFor = (name$1) => {
		const hosts = opts.bases ?? (opts.base !== void 0 ? [opts.base] : discoverAllHostBases());
		return name$1.startsWith("@deepseek-ai/") ? hosts : [join(pluginRoot, "package.json"), ...hosts];
	};
	return async (name$1) => {
		const candidates = candidatesFor(name$1);
		let firstError = null;
		for (const base of candidates) try {
			return await import(pathToFileURL(createRequire(base).resolve(name$1)).href);
		} catch (error) {
			if (firstError === null) firstError = error;
		}
		if (firstError !== null) throw firstError;
		throw Object.assign(/* @__PURE__ */ new Error(`找不到宿主安装目录，无法装载 ${name$1}（可用 DSH_HOST_BASE 指定 @deepseek-ai/dsh/package.json）`), { code: "HOST_BASE_NOT_FOUND" });
	};
}

//#endregion
//#region src/compaction.ts
/** 行名字符串（诊断显示用）。 */
const name = "task-summary-compaction";
/** 必需注入与官方基类相同（官方引擎行就是这三面；行内实例化会真用它们）。 */
const inject = [
	"llm",
	"tokenMeter",
	"sessions"
];
/** 会话的任务记录来源：routerCore 可用则读该会话派发的任务，否则 undefined（回退）。 */
async function sessionRecords(ctx, sessionId) {
	if (sessionId === void 0) return void 0;
	const core = ctx.reflect?.get?.("routerCore");
	if (core?.listDispatchedTasks === void 0) return void 0;
	try {
		return await core.listDispatchedTasks(sessionId);
	} catch {
		return;
	}
}
/**
* 动态子类化：以宿主运行时的 BasicCompactionEngine 为基类，构造一个只覆盖
* summarize 的子类。基类构造自注册 compaction 服务（Service 语义），实例化
* 完成即完成替换。基类 summarize 经原型链显式调用（动态 extends 的值上
* super 不可静态校验，用 Object.getPrototypeOf 取基类原型）。
*
* 导出仅供测试驱动（tests/task-summary-engine.spec.ts 以结构兼容的假基类
* 驱动真子类）；apply 行内自用。
*/
function subclass(base) {
	class TaskSummaryCompactionEngine extends base {
		constructor(ctx, config) {
			super(ctx, config);
		}
		async summarize(input, agent, signal) {
			const sessionId = agent?.session?.id;
			const records = await sessionRecords(this.ctx, sessionId);
			const fallback = async () => {
				return Object.getPrototypeOf(TaskSummaryCompactionEngine.prototype).summarize.call(this, input, agent, signal);
			};
			const verdict = await taskSummarySummarize(records, fallback, input, agent, signal);
			if (verdict === void 0) throw new Error("summarize 不得返回空（基类与账本路径都必须给出信封）");
			return verdict;
		}
	}
	return TaskSummaryCompactionEngine;
}
/**
* 行入口：装载宿主基类并实例化子类（实例自注册为 compaction 服务）。
* 基类装载失败只告警不抛（行已激活、压缩服务缺席——与官方行 import 失败的
* 后果一致，不额外放大）；子类构造只做 super(ctx, config)，失败即基类失败。
*/
async function apply(ctx, config) {
	let mod;
	try {
		mod = await makeHostLoader()("@deepseek-ai/dsh-compaction-basic");
	} catch (error) {
		ctx.logger?.warn?.(`任务描述压缩引擎行未生效（dsh-compaction-basic 装载失败）: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const Basic = mod.BasicCompactionEngine ?? mod.default;
	if (Basic === void 0) {
		ctx.logger?.warn?.("任务描述压缩引擎行未生效（dsh-compaction-basic 未导出 BasicCompactionEngine）");
		return;
	}
	new (subclass(Basic))(ctx, config);
}

//#endregion
export { apply, inject, name, subclass };
//# sourceMappingURL=compaction.js.map