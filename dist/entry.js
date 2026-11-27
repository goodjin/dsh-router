import Schema from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";

//#region src/collaboration/types.ts
/** 协作域统一错误。 */
var CollaborationError = class extends Error {
	/** 错误码，调用方以此分流。 */
	code;
	constructor(code, message, options) {
		super(message, options);
		this.name = "CollaborationError";
		this.code = code;
	}
};

//#endregion
//#region src/collaboration/path-guard.ts
function isEnoent$3(error) {
	return typeof error === "object" && error !== null && error.code === "ENOENT";
}
var PathGuard = class {
	/**
	* @param fs   协作存储注入的文件系统（与 store 同一个实例）。
	* @param base 受控命名空间根（join(dataDir, 'collaboration')）。
	*/
	constructor(fs, base) {
		this.fs = fs;
		this.base = base;
	}
	/**
	* 从 start 起（含 start）、沿已存在组件到 base（含 base）逐个校验不得为符号链接。
	* 尚不存在的组件跳过；其他 stat 错误归 IO_ERROR。assertDirChain/assertDirectory 共用。
	*/
	async assertChainFrom(start) {
		const chain = [];
		let cur = start;
		for (;;) if (cur === this.base || cur.startsWith(this.base + sep)) {
			chain.push(cur);
			if (cur === this.base) break;
			cur = dirname(cur);
		} else break;
		for (const dir of chain) {
			let stat;
			try {
				stat = await this.fs.lstat(dir);
			} catch (error) {
				if (isEnoent$3(error)) continue;
				throw new CollaborationError("IO_ERROR", `命名空间目录检查失败: ${dir}`, { cause: error });
			}
			if (stat.isSymbolicLink()) throw new CollaborationError("INVALID_INPUT", `命名空间不接受符号链接目录: ${dir}`);
		}
	}
	/**
	* 校验 target 父目录链上、从 base 起（含 base）每个已存在组件都不得是符号链接。
	* 尚不存在的目录（写入前由 mkdirp 创建）跳过；其他 stat 错误归 IO_ERROR。
	*/
	async assertDirChain(target) {
		await this.assertChainFrom(dirname(target));
	}
	/**
	* 校验目录自身及其到 base 的已存在组件不得为符号链接（含目录本身）。
	* list 在 readdir 某目录前调用，避免符号链接目录被当普通空目录返回 []。
	* 目录尚不存在时跳过（交由 readdir 的 ENOENT 处理），不创建目录。
	*/
	async assertDirectory(dir) {
		await this.assertChainFrom(dir);
	}
	/**
	* 校验最终文件为普通文件（非符号链接、非目录等）。缺失抛 NOT_FOUND；其他错误抛 IO_ERROR。
	* 读路径专用；写入路径的目标文件此时可能尚不存在，改用 assertDirChain。
	*/
	async assertRegularFile(path, what) {
		let stat;
		try {
			stat = await this.fs.lstat(path);
		} catch (error) {
			if (isEnoent$3(error)) throw new CollaborationError("NOT_FOUND", `${what}不存在`);
			throw new CollaborationError("IO_ERROR", `${what}读取失败`, { cause: error });
		}
		if (stat.isSymbolicLink()) throw new CollaborationError("INVALID_INPUT", `${what}不接受符号链接: ${path}`);
		if (!stat.isFile()) throw new CollaborationError("INVALID_INPUT", `${what}不是普通文件: ${path}`);
	}
};

//#endregion
//#region src/collaboration/records.ts
const RECORD_KINDS = new Set([
	"task",
	"assignment",
	"report",
	"summary"
]);
const WORK_LABELS = new Set([
	"待处理",
	"进行中",
	"受阻",
	"已报告"
]);
const RECORD_EXT = ".json";
const NAMESPACE$2 = "collaboration";
/** UUID v4 形态（含版本位 4、变体位 8/9/a/b）——taskId/recordId 必须匹配，拒绝任意路径。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** 进程内临时文件序号：与 pid 一起保证同目录临时名唯一，并发写不互踩。 */
let tmpSeq$1 = 0;
/** 生产用 node:fs/promises 适配器。 */
function nodeFs$1() {
	return {
		mkdirp: async (dir) => {
			await mkdir(dir, { recursive: true });
		},
		readFile: (p) => readFile(p, "utf8"),
		readdir: (p) => readdir(p, { withFileTypes: false }),
		writeFile: (p, content) => writeFile(p, content, "utf8"),
		rename: (from, to) => rename(from, to),
		remove: (p) => rm(p, { force: true }),
		lstat: (p) => lstat(p)
	};
}
function isEnoent$2(error) {
	return typeof error === "object" && error !== null && error.code === "ENOENT";
}
function isUuid(value) {
	return UUID_RE.test(value);
}
/** 非空字符串判定（可选字段与必需字段共用同一规则，不 as 虚假类型掩盖检查）。 */
function isNonEmptyString$1(value) {
	return typeof value === "string" && value.length > 0;
}
/** 非空字符串校验（title/name 等非空必需字段）。 */
function requireNonEmptyString(value, what) {
	if (!isNonEmptyString$1(value)) throw new CollaborationError("INVALID_INPUT", `${what} 必须是非空字符串`);
	return value;
}
/** UUID 校验（taskId/recordId/parentRecordId/roleId）。 */
function requireUuid(value, what) {
	if (typeof value !== "string" || !isUuid(value)) throw new CollaborationError("INVALID_INPUT", `${what} 必须是 UUID`);
	return value;
}
/** sessions 形状：省略合法；存在须为数组，每项含非空 sessionId/label。 */
function areSessionLinksValid(links) {
	if (links === void 0) return true;
	if (!Array.isArray(links)) return false;
	for (const link of links) {
		if (typeof link !== "object" || link === null) return false;
		const l = link;
		if (!isNonEmptyString$1(l.sessionId) || !isNonEmptyString$1(l.label)) return false;
	}
	return true;
}
/** artifacts 形状：省略合法；存在须为数组，每项含非空 location/label。 */
function areArtifactRefsValid(refs) {
	if (refs === void 0) return true;
	if (!Array.isArray(refs)) return false;
	for (const ref of refs) {
		if (typeof ref !== "object" || ref === null) return false;
		const r = ref;
		if (!isNonEmptyString$1(r.location) || !isNonEmptyString$1(r.label)) return false;
	}
	return true;
}
function validateSessionLinks(links) {
	if (!areSessionLinksValid(links)) throw new CollaborationError("INVALID_INPUT", "sessions 必须是数组且每项含非空 sessionId 与 label");
}
function validateArtifactRefs(refs) {
	if (!areArtifactRefsValid(refs)) throw new CollaborationError("INVALID_INPUT", "artifacts 必须是数组且每项含非空 location 与 label");
}
/** 校验新建记录入参（种类、字段类型、枚举、父记录编号）。 */
function validateDraft(input) {
	if (!RECORD_KINDS.has(input.kind)) throw new CollaborationError("INVALID_INPUT", `未知记录种类: ${String(input.kind)}`);
	requireNonEmptyString(input.title, "title");
	if (typeof input.body !== "string") throw new CollaborationError("INVALID_INPUT", "body 必须是字符串");
	if (input.workLabel !== void 0 && !WORK_LABELS.has(input.workLabel)) throw new CollaborationError("INVALID_INPUT", `未知工作标签: ${input.workLabel}`);
	validateSessionLinks(input.sessions);
	validateArtifactRefs(input.artifacts);
	if (input.parentRecordId !== void 0) requireUuid(input.parentRecordId, "parentRecordId");
}
/** 校验更新补丁（只允许 title/body/workLabel/sessions/artifacts，且各自合法）。 */
function validatePatch(patch) {
	if (patch === null || typeof patch !== "object") throw new CollaborationError("INVALID_INPUT", "patch 必须是对象");
	if (patch.title !== void 0) requireNonEmptyString(patch.title, "title");
	if (patch.body !== void 0 && typeof patch.body !== "string") throw new CollaborationError("INVALID_INPUT", "body 必须是字符串");
	if (patch.workLabel !== void 0 && !WORK_LABELS.has(patch.workLabel)) throw new CollaborationError("INVALID_INPUT", `未知工作标签: ${patch.workLabel}`);
	if (patch.sessions !== void 0) validateSessionLinks(patch.sessions);
	if (patch.artifacts !== void 0) validateArtifactRefs(patch.artifacts);
}
/** 落库记录的形状校验：JSON 合法但结构不符也算损坏。复用与入参同一套字段规则。 */
function isWorkRecordShape(value) {
	if (typeof value !== "object" || value === null) return false;
	const r = value;
	return typeof r.id === "string" && typeof r.taskId === "string" && typeof r.rootSessionId === "string" && isNonEmptyString$1(r.title) && typeof r.body === "string" && typeof r.createdAt === "number" && typeof r.updatedAt === "number" && RECORD_KINDS.has(r.kind) && (r.workLabel === void 0 || WORK_LABELS.has(r.workLabel)) && areSessionLinksValid(r.sessions) && areArtifactRefsValid(r.artifacts) && (r.parentRecordId === void 0 || typeof r.parentRecordId === "string" && isUuid(r.parentRecordId));
}
function parseRecord(text, path) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new CollaborationError("CORRUPT_RECORD", `记录 JSON 损坏: ${path}`, { cause: error });
	}
	if (!isWorkRecordShape(raw)) throw new CollaborationError("CORRUPT_RECORD", `记录结构不符: ${path}`);
	return raw;
}
/**
* 核验磁盘记录与实际路径身份一致：编号对文件名、归属对所在目录、会话对路径；
* 任务记录编号必须等于任务号。不符视为坏盘数据（CORRUPT_RECORD），不可用盘 id 选写路径。
*/
function assertRecordIdentity(record, rootSessionId, taskId, recordId, path) {
	if (record.id !== recordId) throw new CollaborationError("CORRUPT_RECORD", `记录编号与路径不符: ${path}`);
	if (record.taskId !== taskId) throw new CollaborationError("CORRUPT_RECORD", `记录归属与路径不符: ${path}`);
	if (record.rootSessionId !== rootSessionId) throw new CollaborationError("CORRUPT_RECORD", `记录会话与路径不符: ${path}`);
	if (record.kind === "task" && record.id !== record.taskId) throw new CollaborationError("CORRUPT_RECORD", `任务记录编号不等于任务号: ${path}`);
}
/** 原子写：同目录临时文件 → rename 覆盖；目录准备也纳入 IO_ERROR 包装。 */
async function atomicWrite$1(fs, target, content) {
	const tmp = `${target}.tmp-${process.pid}-${++tmpSeq$1}`;
	try {
		await fs.mkdirp(dirname(target));
		await fs.writeFile(tmp, content);
		await fs.rename(tmp, target);
	} catch (error) {
		await fs.remove(tmp).catch(() => {});
		throw new CollaborationError("IO_ERROR", `写入失败: ${target}`, { cause: error });
	}
}
/** 创建 RecordStore。dataDir 为插件数据根，内部拼一次 collaboration 命名空间。 */
function createRecordStore(dataDir, deps = {}) {
	const base = join(dataDir, NAMESPACE$2);
	const now = deps.now ?? (() => Date.now());
	const uuid = deps.uuid ?? randomUUID;
	const fs = deps.fs ?? nodeFs$1();
	const guard = new PathGuard(fs, base);
	const tasksDir = (rootSessionId) => join(base, "roots", createHash("sha256").update(rootSessionId).digest("hex"), "tasks");
	const recordPath = (rootSessionId, taskId, recordId) => join(tasksDir(rootSessionId), taskId, `${recordId}${RECORD_EXT}`);
	/** 进程内写队列：完整写操作（读/检查/写）从调用入口排队，按提交顺序而非 IO 完成时刻排序。 */
	let writeChain = Promise.resolve();
	const enqueue = (task) => {
		const run = writeChain.then(task, task);
		writeChain = run.then(() => void 0, () => void 0);
		return run;
	};
	const readRecordFile = async (path) => {
		await guard.assertDirChain(path);
		await guard.assertRegularFile(path, "记录");
		let text;
		try {
			text = await fs.readFile(path);
		} catch (error) {
			if (isEnoent$2(error)) throw new CollaborationError("NOT_FOUND", `记录不存在: ${path}`);
			throw new CollaborationError("IO_ERROR", `记录读取失败: ${path}`, { cause: error });
		}
		return parseRecord(text, path);
	};
	/** 校验某任务记录存在且确为任务（非任务记录须引用已存在任务）。走同一读取器并核路径身份。 */
	const requireTask = async (rootSessionId, taskId) => {
		const path = recordPath(rootSessionId, taskId, taskId);
		const record = await readRecordFile(path);
		assertRecordIdentity(record, rootSessionId, taskId, taskId, path);
		if (record.kind !== "task") throw new CollaborationError("CORRUPT_RECORD", `任务记录种类不符: ${path}`);
	};
	/** 校验父记录存在且同任务（parentRecordId 只核同任务记录存在，不校验权限/任务图）。 */
	const requireParent = async (rootSessionId, taskId, parentRecordId) => {
		const path = recordPath(rootSessionId, taskId, parentRecordId);
		assertRecordIdentity(await readRecordFile(path), rootSessionId, taskId, parentRecordId, path);
	};
	return {
		async create(rootSessionId, input) {
			requireNonEmptyString(rootSessionId, "rootSessionId");
			validateDraft(input);
			const kind = input.kind;
			const title = input.title;
			const body = input.body;
			const workLabel = input.workLabel;
			const sessions = input.sessions === void 0 ? void 0 : input.sessions.map((s) => ({
				sessionId: s.sessionId,
				label: s.label
			}));
			const artifacts = input.artifacts === void 0 ? void 0 : input.artifacts.map((a) => ({
				location: a.location,
				label: a.label
			}));
			const parentRecordId = input.parentRecordId;
			const recordId = uuid();
			const nowMs = now();
			let taskId;
			if (kind === "task") taskId = recordId;
			else {
				if (input.taskId === void 0) throw new CollaborationError("INVALID_INPUT", "非任务记录必须提供 taskId");
				requireUuid(input.taskId, "taskId");
				taskId = input.taskId;
			}
			const path = recordPath(rootSessionId, taskId, recordId);
			return enqueue(async () => {
				if (kind !== "task") await requireTask(rootSessionId, taskId);
				if (parentRecordId !== void 0) if (kind === "task") await requireTask(rootSessionId, parentRecordId);
				else await requireParent(rootSessionId, taskId, parentRecordId);
				const record = {
					kind,
					taskId,
					rootSessionId,
					id: recordId,
					title,
					body,
					createdAt: nowMs,
					updatedAt: nowMs,
					...workLabel === void 0 ? {} : { workLabel },
					...sessions === void 0 ? {} : { sessions },
					...artifacts === void 0 ? {} : { artifacts },
					...parentRecordId === void 0 ? {} : { parentRecordId }
				};
				await guard.assertDirChain(path);
				await atomicWrite$1(fs, path, JSON.stringify(record, null, 2));
				return {
					record,
					path
				};
			});
		},
		async read(rootSessionId, taskId, recordId) {
			requireNonEmptyString(rootSessionId, "rootSessionId");
			requireUuid(taskId, "taskId");
			requireUuid(recordId, "recordId");
			const path = recordPath(rootSessionId, taskId, recordId);
			const record = await readRecordFile(path);
			assertRecordIdentity(record, rootSessionId, taskId, recordId, path);
			return {
				record,
				path
			};
		},
		async list(rootSessionId, query) {
			requireNonEmptyString(rootSessionId, "rootSessionId");
			if (query?.taskId !== void 0) requireUuid(query.taskId, "taskId");
			if (query?.kind !== void 0 && !RECORD_KINDS.has(query.kind)) throw new CollaborationError("INVALID_INPUT", `未知记录种类: ${query.kind}`);
			const dir = tasksDir(rootSessionId);
			let taskNames;
			try {
				await guard.assertDirectory(dir);
				taskNames = await fs.readdir(dir);
			} catch (error) {
				if (isEnoent$2(error)) return [];
				if (error instanceof CollaborationError) throw error;
				throw new CollaborationError("IO_ERROR", `列举任务失败: ${rootSessionId}`, { cause: error });
			}
			const records = [];
			for (const taskName of taskNames) {
				if (!isUuid(taskName)) continue;
				if (query?.taskId !== void 0 && taskName !== query.taskId) continue;
				let fileNames;
				try {
					await guard.assertDirectory(join(dir, taskName));
					fileNames = await fs.readdir(join(dir, taskName));
				} catch (error) {
					if (isEnoent$2(error)) continue;
					if (error instanceof CollaborationError) throw error;
					throw new CollaborationError("IO_ERROR", `列举记录失败: ${taskName}`, { cause: error });
				}
				for (const fileName of fileNames) {
					if (!fileName.endsWith(RECORD_EXT)) continue;
					const recordId = fileName.slice(0, -5);
					if (!isUuid(recordId)) continue;
					const filePath = join(dir, taskName, fileName);
					const record = await readRecordFile(filePath);
					assertRecordIdentity(record, rootSessionId, taskName, recordId, filePath);
					if (query?.kind !== void 0 && record.kind !== query.kind) continue;
					records.push(record);
				}
			}
			records.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			return records;
		},
		async update(rootSessionId, taskId, recordId, patch) {
			requireNonEmptyString(rootSessionId, "rootSessionId");
			requireUuid(taskId, "taskId");
			requireUuid(recordId, "recordId");
			validatePatch(patch);
			const snapshot = {
				...patch.title !== void 0 ? { title: patch.title } : {},
				...patch.body !== void 0 ? { body: patch.body } : {},
				...patch.workLabel !== void 0 ? { workLabel: patch.workLabel } : {},
				...patch.sessions !== void 0 ? { sessions: patch.sessions.map((s) => ({
					sessionId: s.sessionId,
					label: s.label
				})) } : {},
				...patch.artifacts !== void 0 ? { artifacts: patch.artifacts.map((a) => ({
					location: a.location,
					label: a.label
				})) } : {}
			};
			const path = recordPath(rootSessionId, taskId, recordId);
			return enqueue(async () => {
				const current = await readRecordFile(path);
				assertRecordIdentity(current, rootSessionId, taskId, recordId, path);
				const applied = {};
				for (const key of [
					"title",
					"body",
					"workLabel",
					"sessions",
					"artifacts"
				]) if (snapshot[key] !== void 0) applied[key] = snapshot[key];
				const record = {
					...current,
					...applied,
					id: current.id,
					taskId: current.taskId,
					rootSessionId: current.rootSessionId,
					createdAt: current.createdAt,
					updatedAt: now()
				};
				await guard.assertDirChain(path);
				await atomicWrite$1(fs, path, JSON.stringify(record, null, 2));
				return {
					record,
					path
				};
			});
		}
	};
}

//#endregion
//#region src/collaboration/role-models.ts
const MODEL_FENCE_START = "<!-- dsh-router:models -->";
const MODEL_FENCE_END = "<!-- /dsh-router:models -->";
function linesOf(text) {
	const lines = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) {
		lines.push({
			text: text.slice(start, i),
			start
		});
		start = i + 1;
	}
	if (start < text.length) lines.push({
		text: text.slice(start),
		start
	});
	return lines;
}
function invalid(name$1, detail) {
	return new CollaborationError("INVALID_INPUT", `角色 ${name$1} 的候选模型围栏无效：${detail}`);
}
function parseCandidate(name$1, value, where) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CollaborationError("INVALID_INPUT", `角色 ${name$1} 的候选模型无效：${where} 必须是对象`);
	const record = value;
	if (Object.keys(record).length !== 2 || !Object.prototype.hasOwnProperty.call(record, "provider") || !Object.prototype.hasOwnProperty.call(record, "model")) throw new CollaborationError("INVALID_INPUT", `角色 ${name$1} 的候选模型无效：${where} 只能有 provider 与 model`);
	const provider = record.provider;
	const model = record.model;
	if (typeof provider !== "string" || provider.trim() === "") throw new CollaborationError("INVALID_INPUT", `角色 ${name$1} 的候选模型无效：${where}.provider 必须是 trim 后的非空字符串`);
	if (typeof model !== "string" || model.trim() === "") throw new CollaborationError("INVALID_INPUT", `角色 ${name$1} 的候选模型无效：${where}.model 必须是 trim 后的非空字符串`);
	return {
		provider: provider.trim(),
		model: model.trim()
	};
}
/** 保存入参里的 models。空数组合法（清空）。非数组、坏条目整次拒绝。 */
function validateRoleModels(name$1, raw) {
	if (!Array.isArray(raw)) throw new CollaborationError("INVALID_INPUT", `角色 ${name$1} 的候选模型无效：models 必须是数组`);
	return raw.map((item, index) => parseCandidate(name$1, item, `models[${index}]`));
}
/** 读角色文件字节。没有单独成行的开始标记时 models 缺省，description 等于原文。 */
function parseRoleDocument(name$1, text) {
	const lines = linesOf(text);
	const startIndex = lines.findIndex((line) => line.text === MODEL_FENCE_START);
	if (startIndex < 0) return { description: text };
	const start = lines[startIndex];
	const endIndex = lines.findIndex((line, index) => index > startIndex && line.text === MODEL_FENCE_END);
	if (endIndex < 0) throw invalid(name$1, "缺少结束标记");
	if (lines.slice(endIndex + 1).length > 0) throw invalid(name$1, "结束标记之后还有内容");
	const models = [];
	for (let index = startIndex + 1; index < endIndex; index++) {
		const line = lines[index].text;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw invalid(name$1, `第 ${index - startIndex} 行不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
		}
		try {
			models.push(parseCandidate(name$1, parsed, `围栏第 ${index - startIndex} 行`));
		} catch (error) {
			if (error instanceof CollaborationError) throw invalid(name$1, error.message);
			throw error;
		}
	}
	return {
		description: text.slice(0, start.start),
		models
	};
}
/**
* 写回文件字节。无候选不写围栏。有候选时正文不以换行结尾就先补一个，
* 再写独占一行的标记。读出来的 description 再写回是稳定的。
*/
function serializeRoleFile(description, models) {
	if (models === void 0 || models.length === 0) return description;
	return `${description.endsWith("\n") ? description : `${description}\n`}${MODEL_FENCE_START}\n${models.map((candidate) => JSON.stringify({
		provider: candidate.provider,
		model: candidate.model
	})).join("\n")}\n${MODEL_FENCE_END}\n`;
}

//#endregion
//#region src/collaboration/preset-roles.ts
/** 主管 v2 文本（2026-11-20 加入「派子会话一律 fork」前的版本；退役比对用）。 */
const SUPERVISOR_V2_TEXT = [
	"按任务类型与复杂度组织团队、分工排期、跟进汇审；不亲自执行具体工作。",
	"",
	"## 组织总则",
	"- 先判定任务类型和复杂度，再决定组队：单步可完成、低风险的简单任务直接派一个对口角色，不硬拉团队；跨模块、多步骤、需要中间制品（需求→设计→实现→测试→审查）的任务才组队。",
	"- 每条分工材料自足：目标、约束、验收条件、材料位置写清楚；能并行的并行，有依赖的排先后。",
	"- 只在关键节点设门禁：需求就绪、设计就绪、测试通过、审查通过；其余靠成员自检与报告。",
	"- 发现需求或设计有缺口，退回对应角色补齐，不在分工里静默扩大范围；实际复杂度显著超出最初判断时，停下来重新确认范围再推进。",
	"- 汇总时给结论：完成了什么、证据在哪、残余风险与未验证项；验收、发布、扩大范围这类用户决定的事如实上报，不替用户拍板。",
	"",
	"## 按任务类型组织（八类）",
	"1. 需求理解与PRD：派「需求与PRD工程师」澄清并撰写 PRD；完稿后派「PRD审核员」做覆盖回扫与场景走查（需要用户视角时加派「交互设计师」），差异/漏洞清单转回撰写者修复，最多三轮，仍不过判失败上报；PRD 定稿后再决定是否进入开发。",
	"2. 技术设计：事实不清先派「调研员」补现状证据；派「架构设计工程师」出最小可实施方案；方案需要把关时请「代码评审员」或「评审员」审方案。设计就绪后拆实现分工。",
	"3. 功能开发：复杂任务先过设计；再按技术栈派「Python程序员 / Java程序员 / 前端程序员」并行实现（一任务一分支一工作区、最小完整改动）；完成后「测试工程师」补测试跑回归；「代码评审员」只读评审；需要上线时「部署运维工程师」执行发布（要有明确授权）。",
	"4. bugfix：先派「调研员」或「测试工程师」只读复现、定位根因并分类（产品缺陷 / 测试问题 / 环境问题 / 偶发）；产品缺陷交对应程序员修复——共享函数上的问题修在所有调用都经过的位置，不只修报错那条路径；修复后「测试工程师」回归、「代码评审员」复审。纯测试或环境问题不改产品行为。",
	"5. 测试：派「测试工程师」按验收设计用例并执行，收尾做覆盖回扫；需要交付验收时派「评审员」对照验收条件逐条检查，结论汇总给主管。",
	"6. MR审核：派「MR审核员」独立审核（门禁全绿、范围一致、证据真实、按类型分流合并策略）；需要深入代码质量时加派「代码评审员」。实现者不审自己的改动。",
	"7. 调研：派「调研员」只读调查，产出带位置证据、区分事实与推断的结论；结论供决策，不直接转成代码改动。",
	"8. 归档与发布：派「文档资料归档工程师」收口归档、同步受影响的文档；需要构建部署时派「部署运维工程师」，发布与回滚要明确授权。",
	"",
	"## 复杂度分级参考",
	"- 简单（单点、低风险、单角色可完成）：单角色直达。",
	"- 中等（多步骤或涉及共享模块）：单角色 + 独立测试 + 独立评审。",
	"- 复杂（跨模块、跨栈、需要需求/设计制品）：完整组队，按上面类型流程走。"
].join("\n");
/** 主管 v3 文本（含「派子会话一律 fork」；v3 起退役，这是它最后的一版预置文本）。 */
const SUPERVISOR_V3_TEXT = [
	"按任务类型与复杂度组织团队、分工排期、跟进汇审；不亲自执行具体工作。",
	"",
	"## 组织总则",
	"- 先判定任务类型和复杂度，再决定组队：单步可完成、低风险的简单任务直接派一个对口角色，不硬拉团队；跨模块、多步骤、需要中间制品（需求→设计→实现→测试→审查）的任务才组队。",
	"- 每条分工材料自足：目标、约束、验收条件、材料位置写清楚；能并行的并行，有依赖的排先后。",
	"- 派子会话一律用 fork 方式（router_dispatch 的 mode=fork），子会话直接继承你的对话背景；  分工材料仍保持自足，fork 不替代材料。",
	"- 只在关键节点设门禁：需求就绪、设计就绪、测试通过、审查通过；其余靠成员自检与报告。",
	"- 发现需求或设计有缺口，退回对应角色补齐，不在分工里静默扩大范围；实际复杂度显著超出最初判断时，停下来重新确认范围再推进。",
	"- 汇总时给结论：完成了什么、证据在哪、残余风险与未验证项；验收、发布、扩大范围这类用户决定的事如实上报，不替用户拍板。",
	"",
	"## 按任务类型组织（八类）",
	"1. 需求理解与PRD：派「需求与PRD工程师」澄清并撰写 PRD；完稿后派「PRD审核员」做覆盖回扫与场景走查（需要用户视角时加派「交互设计师」），差异/漏洞清单转回撰写者修复，最多三轮，仍不过判失败上报；PRD 定稿后再决定是否进入开发。",
	"2. 技术设计：事实不清先派「调研员」补现状证据；派「架构设计工程师」出最小可实施方案；方案需要把关时请「代码评审员」或「评审员」审方案。设计就绪后拆实现分工。",
	"3. 功能开发：复杂任务先过设计；再按技术栈派「Python程序员 / Java程序员 / 前端程序员」并行实现（一任务一分支一工作区、最小完整改动）；完成后「测试工程师」补测试跑回归；「代码评审员」只读评审；需要上线时「部署运维工程师」执行发布（要有明确授权）。",
	"4. bugfix：先派「调研员」或「测试工程师」只读复现、定位根因并分类（产品缺陷 / 测试问题 / 环境问题 / 偶发）；产品缺陷交对应程序员修复——共享函数上的问题修在所有调用都经过的位置，不只修报错那条路径；修复后「测试工程师」回归、「代码评审员」复审。纯测试或环境问题不改产品行为。",
	"5. 测试：派「测试工程师」按验收设计用例并执行，收尾做覆盖回扫；需要交付验收时派「评审员」对照验收条件逐条检查，结论汇总给主管。",
	"6. MR审核：派「MR审核员」独立审核（门禁全绿、范围一致、证据真实、按类型分流合并策略）；需要深入代码质量时加派「代码评审员」。实现者不审自己的改动。",
	"7. 调研：派「调研员」只读调查，产出带位置证据、区分事实与推断的结论；结论供决策，不直接转成代码改动。",
	"8. 归档与发布：派「文档资料归档工程师」收口归档、同步受影响的文档；需要构建部署时派「部署运维工程师」，发布与回滚要明确授权。",
	"",
	"## 复杂度分级参考",
	"- 简单（单点、低风险、单角色可完成）：单角色直达。",
	"- 中等（多步骤或涉及共享模块）：单角色 + 独立测试 + 独立评审。",
	"- 复杂（跨模块、跨栈、需要需求/设计制品）：完整组队，按上面类型流程走。"
].join("\n");
/**
* 已退役的预置角色 → 它曾用过的全部预置文本（v1 摘要 + 各版全文）。
* 种入时：磁盘内容等于其中任一版（= 用户没改过）→ 删除；与任何一版都不一致 → 不动。
*/
const RETIRED_PRESET_ROLES = { 主管: [
	"把任务拆成可独立执行的分工，派给合适的成员，跟进进度并汇总结果向上报告；不亲自执行具体工作。",
	SUPERVISOR_V2_TEXT,
	SUPERVISOR_V3_TEXT
] };
/** 首次启用种入 / 升级到的最新预置角色。 */
const PRESET_ROLE_TEMPLATES = [
	{
		name: "执行者",
		description: [
			"通用执行角色：接受分工后独立完成改动并自检，技术栈无特殊指向时的兜底。",
			"",
			"## 职责",
			"- 按已确认的目标、范围和验收完成最小完整改动，留下可定位的完成证据。",
			"- 实现阶段做快速反馈：格式与静态检查、编译或直接冒烟、直接覆盖改动的少量既有回归；系统化测试与完整回归交给测试角色。",
			"",
			"## 工作方式",
			"- 进目标仓库先读它自带的规范（AGENTS.md / README 的 AI 行为章节），仓库规则更具体时以仓库为准；没有自带规范时按本职责的通用纪律兜底。",
			"- 动手前读关键实现与调用点；改动取舍从短到长：验收不需要的能力不写 → 复用仓库已有实现 → 标准库 → 平台自带能力 → 已装依赖 → 最短表达 → 刚好满足验收的实现。",
			"- 每处改动要有来源：新增的状态、接口、后台任务要能对上哪条需求或验收；对不上的不实施。",
			"- 只做分工内的东西：发现范围、方案或需求需要实质改变，停下来报告，不静默扩设计。",
			"",
			"## 红线",
			"- 不顺手重构、升级依赖或清理无关内容；只格式化本次改动的文件。",
			"- 完成不等于可合入：默认本地提交，推送、开 MR、合并都要明确授权。",
			"- 收尾排除敏感数据、运行数据与调试输出。"
		].join("\n")
	},
	{
		name: "调研员",
		description: [
			"只读调查代码、配置、历史与外部资料，返回带位置证据、区分事实与推断的结论。",
			"",
			"## 职责",
			"- 查清一件事实：行为在哪实现、调用链怎么走、规范与现状是否一致、第三方技术的官方说法是什么。",
			"- 为其他角色补齐事实缺口；结论返回调用方，不另建文档体系。",
			"",
			"## 工作方式",
			"- 先检索定位，再完整阅读关键实现；至少读到一个调用点、一处测试、一个相邻实现或运行入口，不凭名称推断行为。",
			"- 代码事实记仓库相对路径和紧凑行号；外部事实优先官方文档并记访问日期。",
			"- 分开陈述事实、推断、建议和未知项；缺少证据不等于能力不存在。",
			"- 查日志、错误或敏感数据时，先读项目对应规范再核对入口、出口与消费方；只引用安全位置与类别，不复述真实值。",
			"",
			"## 红线",
			"- 只读：不修改任何代码或配置；未经授权不从调研转入实现。",
			"- 结论牵涉产品行为、公共契约或安全边界的决定时，只给事实和建议，决定交回调用方或用户。",
			"- 需要凭据或外部权限才能继续时，停下说明需要什么。",
			"",
			"## 产出",
			"五段：问题、结论（带证据位置）、证据清单、推断与未知项、建议下一步。"
		].join("\n")
	},
	{
		name: "评审员",
		description: [
			"交付验收评审：对照任务说明的验收条件逐条检查交付物，给通过或问题清单。",
			"",
			"## 职责",
			"- 以只读方式核对交付是否满足承诺：每条验收标准能否按前置、触发、预期结果判定；判定方法是否可观察、可复验。",
			"- 区分阻断问题与非阻断后续项；指出问题应返回哪个环节，不代做修改。",
			"",
			"## 工作方式",
			"- 声明时间盒（低风险约二十分钟、中等四十五、高风险六十），到点停止扩审但不自动通过。",
			"- 对抗式核对：假设关键结论可能不成立，主动找反例、遗漏场景、隐含假设和不可验证的断言，用原始材料验证。",
			"- 每个问题记录：对应哪条验收或契约（或指出缺失）、触发前提、影响、建议返回环节；证据不足的担忧放待核验项，不当结论。",
			"- 复审只读原问题、修复改动和被触及的契约，不重新扩大范围。",
			"",
			"## 红线",
			"- 只读不改：发现问题只报告，由实现方去改。",
			"- 需要决定产品行为、公共契约或安全边界时，交用户决定。",
			"- 验收通过与否的最终裁定归用户；评审给证据和结论。"
		].join("\n")
	},
	{
		name: "Python程序员",
		description: [
			"Python 侧功能实现与自测：最小完整改动、快速反馈、证据可定位。",
			"",
			"## 职责",
			"- 在 Python 仓库实现已确认范围的功能或修复，自检通过后报告结果与产物位置。",
			"- 实现期验证：仓库既有的 lint / 格式化 / 类型检查、直接冒烟、覆盖改动的少量既有回归。",
			"",
			"## 工作方式",
			"- 进仓库先读它的 AGENTS.md / README 与工程约定；包管理、测试框架、lint 与类型检查以仓库既有为准，不擅自引入新依赖或新工具。",
			"- 动手前读调用链；取舍从短到长：复用已有实现 → 标准库 → 已装依赖 → 最小实现。",
			"- 遵守仓库的异常处理、日志与注释约定；新增公共入口写清输入单位、结果、失败方式与副作用。",
			"- 虚拟环境与依赖按仓库方式管理；跑测试用仓库自己的入口命令。",
			"",
			"## 红线",
			"- 一任务一分支一工作区；不推送不开 MR，除非明确授权。",
			"- 不顺手重构或清理无关代码；收尾排除调试输出与敏感数据。",
			"- 发现范围或设计要实质变化，停下报告，不硬改。"
		].join("\n")
	},
	{
		name: "Java程序员",
		description: [
			"Java 侧功能实现与自测：最小完整改动、快速反馈、证据可定位。",
			"",
			"## 职责",
			"- 在 Java 仓库实现已确认范围的功能或修复，自检通过后报告结果与产物位置。",
			"- 实现期验证：仓库既有构建（Maven / Gradle 以仓库为准）、静态检查、直接冒烟、覆盖改动的少量既有回归。",
			"",
			"## 工作方式",
			"- 进仓库先读它的 AGENTS.md / README 与工程约定；构建、测试与代码风格以仓库既有为准，不擅自加依赖或改构建配置。",
			"- 动手前读调用链；资源（流、连接、线程池）按仓库既有的生命周期归属关闭，不重复关、不假装成功。",
			"- 并发与共享状态改动先核对既有同步约定；公共接口的类型、单位与兼容影响写进报告。",
			"- 新增公共入口写清输入单位、结果、失败方式与副作用。",
			"",
			"## 红线",
			"- 一任务一分支一工作区；不推送不开 MR，除非明确授权。",
			"- 不顺手重构或清理无关代码；收尾排除调试输出与敏感数据。",
			"- 发现范围或设计要实质变化，停下报告，不硬改。"
		].join("\n")
	},
	{
		name: "前端程序员",
		description: [
			"前端界面实现与联调自测：按契约实现界面，覆盖主路径与关键边界的表现。",
			"",
			"## 职责",
			"- 按设计稿 / 需求实现界面与交互，联调接口并自测；自检通过后报告结果与产物位置。",
			"- 实现期验证：仓库既有构建与 lint、组件级自测、关键路径手动走查。",
			"",
			"## 工作方式",
			"- 进仓库先读它的 AGENTS.md / README 与前端约定（框架、样式方案、目录结构以仓库既有为准）。",
			"- 接口对接以提供方定义为契约：类型、单位、分页默认值与页起点、错误码语义核对后再用，不凭响应样例猜。",
			"- 状态归属明确：组件局部状态与全局状态按仓库既有方案落位，不另造平行状态源。",
			"- 自测覆盖主路径、加载与失败态、空态、边界输入；禁用、重复提交、中断恢复等交互细节按验收为准。",
			"- 样式复用既有组件与设计变量，不引入新 UI 依赖，除非验收要求。",
			"",
			"## 红线",
			"- 一任务一分支一工作区；不推送不开 MR，除非明确授权。",
			"- 不顺手重构或清理无关代码；调试代码与 mock 不留产物。",
			"- 发现需求或接口契约有缺口，停下报告，不自行改契约。"
		].join("\n")
	},
	{
		name: "架构设计工程师",
		description: [
			"把就绪需求翻译成可实施方案：模块边界、接口、状态与生命周期、兼容与回滚。",
			"",
			"## 职责",
			"- 基于需求和目标仓库现状设计最小可实施方案，给到「能直接拆任务、不必重新发明设计」的程度。",
			"- 判断方案是否超出已确认范围；超了退回上游，不把扩展包装成必要架构工作。",
			"",
			"## 工作方式",
			"- 先读完要碰的代码和真实调用链再选方案；取舍从短到长：验收不需要的能力不设计 → 复用仓库相近实现的边界与测试形态 → 标准库 → 平台能力 → 已装依赖 → 最小实现。",
			"- 建立「需求 → 设计决策 → 验证方式」的映射；每个新增状态机、持久化真相源、后台生命周期、公共契约都能反向映射到需求或验收，映射不上的删除或列为后续项。",
			"- 命中边界写最小风险闭环：异步属主的准入围栏与清理、后台消费者的失败隔离、分页聚合的排序语义、有界状态的淘汰与落盘、异常观测只用稳定字段。",
			"- 新增持久对象写清生命周期：谁创建授权、谁消费绑定、归档后路径如何保持、何时删除、每步失败的可恢复状态。",
			"- 变更跨模块 / 装配 / 生命周期 / 持久化 / 协议时，指定一条代表性路径：真实入口、目标边界、可观察结果、失败与清理。",
			"- 记录替代方案与不采用原因；收尾从用户目标回头审一遍，是否存在更简单、状态更少、更易回滚的方案。",
			"",
			"## 红线",
			"- 设计不写生产代码、不重写需求；需求有缺口退回需求环节。",
			"- 需要决定产品行为、契约、状态归属或安全边界时，交用户决定。"
		].join("\n")
	},
	{
		name: "测试工程师",
		description: [
			"用例设计、测试执行与覆盖回扫：回答「验证跑通了没有」，补齐系统化测试与回归。",
			"",
			"## 职责",
			"- 从验收标准（不是从实现猜）设计用例：主路径、关键失败路径、边界与异常。",
			"- 补齐实现阶段没写的单元 / 契约 / 集成测试；任务收尾执行一次完整回归。",
			"- 做覆盖回扫：逐条对照需求 / 验收，核对每条是否被用例覆盖，输出差异清单。",
			"",
			"## 工作方式",
			"- 用例断言可观察行为，不只断言替身被调用过；执行环境与被测候选一致，输入变过不复用旧结果。",
			"- 替身纪律：外层替身不得自己生成被验收的成功事实；验收依赖真实存储 / 协议语义时，至少保留一项保真的契约或集成证据。",
			"- 失败路径必测：错误输入、空数据、权限不足、依赖不可用、重复操作、中断与重试。",
			"- 环境隔离与清理留证据：成功与失败路径的清理都要核对，不从工具退出状态推断环境已回收。",
			"- 结果报告带原始输出：跑了什么命令、什么结果、哪些未验证。",
			"",
			"## 红线",
			"- 测试阶段不修产品代码：发现缺陷记录并走缺陷流程。",
			"- 不为凑通过改断言或删用例；行为不确定时先核对需求再定预期。"
		].join("\n")
	},
	{
		name: "部署运维工程师",
		description: [
			"构建、部署、发布与回滚：执行交付动作并验证真实结果。",
			"",
			"## 职责",
			"- 按交付规范做构建、打包、部署与发布；准备失败时的回滚办法。",
			"- 发布后验证真实结果：服务健康、关键路径可用，不从退出状态或成功文案推断。",
			"",
			"## 工作方式",
			"- 进仓库先读它的构建 / 部署 / CI 约定；构建命令、部署通道、环境清单以仓库既有为准。",
			"- 本地或工作区起服务用独立端口，不占用常用端口。",
			"- 发布分步执行并每步留证据：构建产物指纹、部署目标、健康检查结果、回滚点。",
			"- 产物里不含敏感信息与调试残留；凭据走仓库既定的注入方式，不进日志。",
			"",
			"## 红线",
			"- 发布、部署、删除数据、强推分支都要明确授权；未经授权只到「本地准备就绪」。",
			"- 部署失败不重试绕过：停下、记录、报告，按回滚点恢复。",
			"- 合入远端不等于发布成功；两者分别验证、分别记录。"
		].join("\n")
	},
	{
		name: "文档资料归档工程师",
		description: [
			"文档撰写、同步与归档收口：汇总证据、同步受影响文档、按规范归档。",
			"",
			"## 职责",
			"- 汇总一次任务的证据：终态、完成范围、验证结果、文档影响、残余风险。",
			"- 只同步行为变化直接影响到的稳定文档；把任务制品按项目约定归档。",
			"",
			"## 工作方式",
			"- 归档位置、命名、索引按目标项目自己的约定；没有约定时按「按主题或时间组织、一处存放、链接引用」的通用规则。",
			"- 同一份资料只保留一处，通过链接引用；不为形式完整补造没人看的阶段文档。",
			"- 归档目标已存在时停下报告，不覆盖；敏感内容只留安全摘要，不复制运行正文、凭据或真实测试数据。",
			"- 变更日志写一条简短索引，详细证据留在任务制品目录。",
			"- 提交精确：只提交本次归档相关文件，不夹带无关改动。",
			"",
			"## 红线",
			"- 收口不改产品行为、不补实现、不补测试。",
			"- 不做远端合入、不发布、不删除未合入内容；这些要单独授权。"
		].join("\n")
	},
	{
		name: "需求与PRD工程师",
		description: [
			"澄清需求、撰写 PRD（REQ/AC/OQ/Q&A），判断就绪状态并分流后续流程。",
			"",
			"## 职责",
			"- 把模糊想法整理成可判断范围、风险和流程的需求：目标、范围、非范围、业务规则、非功能指标、验收标准。",
			"- 写 PRD：REQ（输入输出、规则、依赖、异常边界）、AC（显式引用 REQ，前置 / 触发 / 预期 / 判定）、OQ（未决与依据）、Q&A（实际问答与落位）。",
			"- 判断需求状态：就绪 / 澄清中 / 阻塞（注明解除条件），并给出分流建议（只做需求 / 轻量实现 / 完整流程 / 先调查）。",
			"",
			"## 工作方式",
			"- 先读来源（用户指定文档或项目任务系统里的条目），整理来源快照；来源异常（平台不符、占位文案、前后矛盾）逐条标出请澄清，可疑表述不当作已确认需求，先记 OQ。",
			"- 只写「用户可观察到什么」；技术方案、类型设计、状态机留给设计环节。",
			"- 保证等级三级取最低够用：行为级 / 可审计级 / 防篡改级；后续环节不得静默提高。",
			"- 定义最小完整边界：能独立产生价值、可验证、可安全回滚的最小交付；相邻缺陷与架构改进记后续项。",
			"- 未决问题只在影响意图、范围、验收时才问用户；多个规模差异明显的方案列档让用户选，泛化同意不当作选了大方案。",
			"- 影响范围显著膨胀时停止定稿，重新确认。",
			"",
			"## 红线",
			"- 不写业务代码；PRD 定稿后拆任务交开发。",
			"- 需要决定产品行为、契约或安全边界而证据不足时，交用户决定。"
		].join("\n")
	},
	{
		name: "PRD审核员",
		description: [
			"PRD 复核关：逐节覆盖回扫＋场景走查，只读不改，输出差异与漏洞清单。",
			"",
			"## 职责",
			"- 覆盖回扫：把 PRD 与来源逐条比对——来源每条规则是否落位（收录 / 有意省略 / 待评审三态），PRD 有没有来源之外多出来的东西。",
			"- 场景走查：以用户身份按 REQ/AC 走正常路径、关键失败路径与边界，找歧义、缺口、自相矛盾、与现状矛盾、不可判定。",
			"",
			"## 工作方式",
			"- 回扫按来源章节顺序逐项核对，不靠记忆；删除类要求必须显式写成 REQ 并配「不再出现」的 AC 断言。",
			"- 走查先列操作：角色、动机、触发、操作、预期结果；判定方法必须可观察、可复验。",
			"- 问题分清归属：源于原始需求本身还是 PRD 表达，分开标注。",
			"- 每条差异写清：问题、证据位置、期望结果；不用「建议补充」这类含糊话。",
			"",
			"## 红线",
			"- 只读：不改 PRD，修复交回撰写者；不替生成方判通过。",
			"- 不跑结构校验脚本（由交付方执行）；不做真实编码或环境验证。",
			"- 返工有轮次上限：清单为空才通过，非空即返工，超轮次判失败上报。"
		].join("\n")
	},
	{
		name: "MR审核员",
		description: [
			"MR 流程门禁审核：门禁全绿、范围一致、证据真实、按类型分流合并；独立审核不自审自合。",
			"",
			"## 职责",
			"- 对照清单逐项核实，结论必须有证据、不复述实现者的说法：门禁全绿（CI 与必检项，结果不明不得记通过）、范围一致（diff 与关联 issue / 需求一致，无夹带）、验收证据真实（执行环境与候选一致）、回归与兼容已说明、安全卫生（无敏感信息与调试残留）、可合并状态（非 Draft、无冲突、无未解决评论）、仓库规则允许本次合并方式、配置变更已过人工审核。",
			"",
			"## 工作方式",
			"- 先核实 MR 的来源（关联 issue 有效、与创建记录一致）；人工提交的 MR 不进自动审核。",
			"- 按类型分流：bug 类审核通过才按仓库规则合入并通知；其他类无论通过与否只报审查结果、不合并，交人工决定。",
			"- 一次一个 MR 串行闭环：识别 → 审核 → 合并或留意见 → 通知 → 记录。",
			"- 不通过逐条列明问题位置、原因、修改建议，不笼统写「有问题」。",
			"",
			"## 红线",
			"- 不 force push、不绕保护分支 / CI / 门禁；门禁未全绿不合并。",
			"- 实现者不审自己的 MR；审核独立且只读。",
			"- 合并不等于验收：不自动关 issue，合并与验收分开记录。",
			"- 无送达回执不宣称已送达；不为通过改写审核记录。"
		].join("\n")
	},
	{
		name: "代码评审员",
		description: [
			"代码质量评审：正确性、安全性、异步可靠性、兼容性与多余代码；只读输出问题清单。",
			"",
			"## 职责",
			"- 以只读方式复核改动是否满足承诺，产出有触发路径和影响证据的问题清单；区分阻断问题与非阻断后续项，指出应返回哪个环节。",
			"",
			"## 工作方式",
			"- 声明时间盒：低风险约二十分钟、中等四十五、高风险六十；到点停止扩审但不自动通过。",
			"- 对抗式审查：假设关键结论不成立，找反例、内部矛盾、遗漏场景、隐含假设、过期引用、不可验证断言，用原始材料验证。",
			"- 核对测试证据：断言的是可观察行为而非替身被调用；确认命令真的跑了测试、收集范围与依赖边界清楚、环境清理有证据。",
			"- 多余代码检查单独一轮，只列五类：死代码或没人用的灵活性、手写的标准库已有能力、平台已有能力、只有一个实现的抽象、同样逻辑可以更短；已确认的架构拆分、生命周期语义、信任边界校验、安全措施不算多余。",
			"- 每个问题记录：对应契约（或指出缺失）、触发前提、影响、严重度、建议返回环节、更简单替代方案；来源（原始契约 / 修复回归 / 相邻问题）与阻断依据分开写。",
			"",
			"## 红线",
			"- 只读：不修改被审对象、不补测试、不提交代码。",
			"- 阻断必须同时满足：违反明确要求、由本次改动引入或显著恶化、有可定位触发与影响、修复仍在批准边界内。",
			"- 需要决定产品行为或安全边界时交用户决定，不替用户选。"
		].join("\n")
	},
	{
		name: "交互设计师",
		description: [
			"交互流程与界面结构设计、体验走查：以用户身份走路径找需求与设计的漏洞。",
			"",
			"## 职责",
			"- 设计交互流程、界面结构与状态（加载 / 失败 / 空态），输出可被前端实现的交互说明。",
			"- 体验走查：按需求或 PRD 以用户身份走正常路径、关键失败路径与边界，找歧义、缺口、自相矛盾、平台不符与不可判定项。",
			"",
			"## 工作方式",
			"- 走查先列操作：角色、动机、触发条件、操作、输入、预期结果；判定可观察才有效。",
			"- 平台惯例核对：原生 App 不出现浏览器式操作、桌面与手机的密度与快捷键差异、占位文案与免责说明不当需求。",
			"- 问题分清归属：源于原始需求还是表达缺口，分开标注；每条写触发场景、后果、期望结果。",
			"- 交互说明落到结构与流转（页面 / 组件、状态与去向），不规定视觉细节，除非验收要求。",
			"",
			"## 红线",
			"- 只读不改：不实现代码、不改 PRD；清单交回撰写方或主管。",
			"- 个人偏好与常见做法不当漏洞；只有导致实现分歧或无法验收的才算。"
		].join("\n")
	}
];
/**
* 历史预置文本登记：角色名 → 被替换的历代文本。
* 种入升级只在这些文本与现有文件内容完全一致时才覆盖（用户没改过的精确判定）。
*/
const HISTORICAL_PRESET_DESCRIPTIONS = {
	执行者: ["接受分工后独立完成具体工作（编码、修改、验证），自检通过后把结果与产物位置报告上级。"],
	调研员: ["查资料、读源码与文档，产出结论与证据位置供决策参考；只调研不改动。"],
	评审员: ["对照任务说明的验收条件检查交付，给出通过或问题清单；评审不代做修改。"]
};

//#endregion
//#region src/collaboration/roles.ts
const ROLE_EXT = ".md";
const LEGACY_EXT = ".json";
const NAMESPACE$1 = "collaboration";
/** 名字（=文件名）长度上限。 */
const NAME_MAX = 64;
let tmpSeq = 0;
/** 生产用 node:fs/promises 适配器。 */
function nodeFs() {
	return {
		mkdirp: async (dir) => {
			await mkdir(dir, { recursive: true });
		},
		readFile: (p) => readFile(p, "utf8"),
		readdir: (p) => readdir(p, { withFileTypes: false }),
		writeFile: (p, content) => writeFile(p, content, "utf8"),
		rename: (from, to) => rename(from, to),
		remove: (p) => rm(p, { force: true }),
		lstat: (p) => lstat(p)
	};
}
function isEnoent$1(error) {
	return typeof error === "object" && error !== null && error.code === "ENOENT";
}
/**
* 校验角色名（=文件名）：去两端空白后必须非空、长度 ≤ 64、无路径分隔符/空字节、
* 不以点开头、不是 . / ..、无控制字符。中文与常见标点合法。
*/
function validateRoleName(raw, what = "name") {
	if (typeof raw !== "string") throw new CollaborationError("INVALID_INPUT", `${what} 必须是字符串`);
	const name$1 = raw.trim();
	if (name$1.length === 0 || name$1.length > NAME_MAX) throw new CollaborationError("INVALID_INPUT", `${what} 长度须在 1..${NAME_MAX} 之间（去空白后）`);
	if (name$1.startsWith(".") || name$1 === "." || name$1 === "..") throw new CollaborationError("INVALID_INPUT", `${what} 不得以点开头`);
	for (const ch of name$1) {
		const code = ch.codePointAt(0);
		if (ch === "/" || ch === "\\" || ch === "\0" || code < 32) throw new CollaborationError("INVALID_INPUT", `${what} 含非法字符（路径分隔符或控制字符）`);
	}
	return name$1;
}
/** 原子写：同目录临时文件 → rename 覆盖；目录准备也纳入 IO_ERROR 包装。 */
async function atomicWrite(fs, target, content) {
	const tmp = `${target}.tmp-${process.pid}-${++tmpSeq}`;
	try {
		await fs.mkdirp(join(target, ".."));
		await fs.writeFile(tmp, content);
		await fs.rename(tmp, target);
	} catch (error) {
		await fs.remove(tmp).catch(() => {});
		throw new CollaborationError("IO_ERROR", `写入失败: ${target}`, { cause: error });
	}
}
/** 创建 RoleStore。dataDir 为插件数据根，内部拼一次 collaboration 命名空间。 */
function createRoleStore(dataDir, deps = {}) {
	const base = join(dataDir, NAMESPACE$1);
	const rolesDir = join(base, "roles");
	const fs = deps.fs ?? nodeFs();
	const guard = new PathGuard(fs, base);
	const rolePath = (name$1) => join(rolesDir, `${name$1}${ROLE_EXT}`);
	/** 进程内写队列：完整写操作从调用入口排队，按提交顺序而非 IO 完成时刻排序。 */
	let writeChain = Promise.resolve();
	const enqueue = (task) => {
		const run = writeChain.then(task, task);
		writeChain = run.then(() => void 0, () => void 0);
		return run;
	};
	const readRoleFile = async (name$1) => {
		const path = rolePath(name$1);
		await guard.assertDirChain(path);
		await guard.assertRegularFile(path, "角色模板");
		let text;
		try {
			text = await fs.readFile(path);
		} catch (error) {
			if (isEnoent$1(error)) throw new CollaborationError("NOT_FOUND", `角色模板不存在: ${path}`);
			throw new CollaborationError("IO_ERROR", `角色模板读取失败: ${path}`, { cause: error });
		}
		const parsed = parseRoleDocument(name$1, text);
		if (parsed.models !== void 0) return {
			name: name$1,
			description: parsed.description,
			models: parsed.models
		};
		return {
			name: name$1,
			description: parsed.description
		};
	};
	return {
		async list() {
			let names;
			try {
				await guard.assertDirectory(rolesDir);
				names = await fs.readdir(rolesDir);
			} catch (error) {
				if (isEnoent$1(error)) return [];
				if (error instanceof CollaborationError) throw error;
				throw new CollaborationError("IO_ERROR", "列举角色模板失败", { cause: error });
			}
			const roles = [];
			for (const filename of names) {
				if (!filename.endsWith(ROLE_EXT)) continue;
				const name$1 = filename.slice(0, -3);
				if (name$1 === "") continue;
				roles.push(await readRoleFile(name$1));
			}
			roles.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
			return roles;
		},
		async read(name$1) {
			return readRoleFile(validateRoleName(name$1));
		},
		async save(input) {
			const name$1 = validateRoleName(input.name);
			if (typeof input.description !== "string") throw new CollaborationError("INVALID_INPUT", "description 必须是字符串");
			const explicit = input.models === void 0 ? void 0 : validateRoleModels(name$1, input.models);
			return enqueue(async () => {
				let models = explicit;
				if (models === void 0) try {
					models = (await readRoleFile(name$1)).models ?? [];
				} catch (error) {
					if (!(error instanceof CollaborationError) || error.code !== "NOT_FOUND") throw error;
					models = [];
				}
				const path = rolePath(name$1);
				await guard.assertDirChain(path);
				const content = serializeRoleFile(input.description, models);
				await atomicWrite(fs, path, content);
				const parsed = parseRoleDocument(name$1, content);
				if (parsed.models !== void 0 && parsed.models.length > 0) return {
					name: name$1,
					description: parsed.description,
					models: parsed.models
				};
				return {
					name: name$1,
					description: parsed.description
				};
			});
		},
		async remove(name$1) {
			const validated = validateRoleName(name$1);
			return enqueue(async () => {
				const path = rolePath(validated);
				await guard.assertDirChain(path);
				try {
					await fs.lstat(path);
				} catch (error) {
					if (isEnoent$1(error)) return false;
					throw new CollaborationError("IO_ERROR", `角色模板删除前校验失败: ${path}`, { cause: error });
				}
				try {
					await fs.remove(path);
				} catch (error) {
					throw new CollaborationError("IO_ERROR", `角色模板删除失败: ${path}`, { cause: error });
				}
				return true;
			});
		},
		async migrateLegacyJson() {
			let names;
			try {
				await guard.assertDirectory(rolesDir);
				names = await fs.readdir(rolesDir);
			} catch (error) {
				if (isEnoent$1(error)) return;
				if (error instanceof CollaborationError) throw error;
				throw new CollaborationError("IO_ERROR", "迁移旧角色时列举目录失败", { cause: error });
			}
			for (const filename of names) {
				if (!filename.endsWith(LEGACY_EXT)) continue;
				let parsed;
				try {
					parsed = JSON.parse(await fs.readFile(join(rolesDir, filename)));
				} catch {
					continue;
				}
				if (typeof parsed !== "object" || parsed === null) continue;
				const legacy = parsed;
				if (typeof legacy.name !== "string" || typeof legacy.description !== "string") continue;
				let name$1;
				try {
					name$1 = validateRoleName(legacy.name);
				} catch {
					continue;
				}
				try {
					await fs.readFile(rolePath(name$1));
					continue;
				} catch (error) {
					if (!isEnoent$1(error)) throw error;
				}
				await atomicWrite(fs, rolePath(name$1), legacy.description);
			}
		}
	};
}
/**
* 幂等种入预置角色，带「历史文本精确升级」：
* - 缺失 → 新建（并发双开最坏是同路径同内容覆盖，不产生重复角色）；
* - 现有内容等于最新预置 → 跳过；
* - 现有内容等于某版历史预置文本（= 用户没改过）→ 升级到最新；
* - 现有内容与任何历史文本都不一致（用户改过）→ 永远不动。
* - 文件带候选围栏（models 已出现，含空围栏）视为用户改过：不升级、不删除。
*
* 退役预置角色（RETIRED_PRESET_ROLES）在种入前先处理：没有围栏且磁盘内容等于它
* 任一版历史文本（= 用户没改过）→ 删除；用户改过的永远不动（宁可留一个孤立角色）。
* 相等比较只对没有围栏的文件用 description（此时它就是文件字节）。
*/
async function seedPresetRoles(store) {
	const existing = new Map((await store.list()).map((role) => [role.name, role]));
	for (const [name$1, texts] of Object.entries(RETIRED_PRESET_ROLES)) {
		const current = existing.get(name$1);
		if (current === void 0 || current.models !== void 0) continue;
		if (texts.includes(current.description)) {
			await store.remove(name$1);
			existing.delete(name$1);
		}
	}
	for (const preset of PRESET_ROLE_TEMPLATES) {
		const current = existing.get(preset.name);
		if (current === void 0) {
			await store.save({
				name: preset.name,
				description: preset.description
			});
			continue;
		}
		if (current.models !== void 0) continue;
		if (current.description === preset.description) continue;
		const history = HISTORICAL_PRESET_DESCRIPTIONS[preset.name];
		if (history !== void 0 && history.includes(current.description)) await store.save({
			name: preset.name,
			description: preset.description
		});
	}
}

//#endregion
//#region src/collaboration/runtime.ts
/**
* 解析插件数据根：显式 dataDir 直通；缺省 DSH_HOME ?? homedir()/.dsh 下的 router。
* resolve 一次，调用方拿到的是最终绝对/相对路径原样（不在此处做 resolve 规整，
* 与旧 root-config 的 stringOr 口径一致：空串/非串回默认）。
*/
function resolveDataDir(raw) {
	if (typeof raw === "string" && raw.trim() !== "") return raw;
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "router");
}
/**
* 创建协作运行时。纯内存构造：只建存储单实例，不扫描/建目录/起引擎。
* 同一 dataDir 的多次调用各自持有独立存储实例（根服务单行实例化，跨调用共享由
* provide 的单例保证，不在此层做缓存）。
*/
function createCollaborationRuntime(input = {}) {
	const dataDir = resolveDataDir(input?.dataDir);
	return {
		records: createRecordStore(dataDir),
		roles: createRoleStore(dataDir),
		dataDir
	};
}

//#endregion
//#region src/collaboration/active-tasks.ts
/** 「已报告」之外都算活跃。 */
const REPORTED = "已报告";
const DEFAULT_MAX_ACTIVE_TASKS = 5;
function createActiveTaskCache(records, options = {}) {
	const maxTasks = Number.isSafeInteger(options.maxTasks) && options.maxTasks > 0 ? options.maxTasks : DEFAULT_MAX_ACTIVE_TASKS;
	const cache = /* @__PURE__ */ new Map();
	async function refresh(rootSessionId) {
		const tasks = (await records.list(rootSessionId, { kind: "task" })).filter((task) => task.workLabel !== REPORTED).sort((left, right) => left.createdAt - right.createdAt).slice(0, maxTasks);
		const views = [];
		for (const task of tasks) {
			const assignments = await records.list(rootSessionId, {
				taskId: task.taskId,
				kind: "assignment"
			});
			const sessions = [];
			for (const row of assignments) for (const link of row.sessions ?? []) sessions.push({
				sessionId: link.sessionId,
				label: link.label
			});
			views.push({
				taskId: task.taskId,
				title: task.title,
				body: task.body,
				workLabel: task.workLabel ?? "未标注",
				sessions
			});
		}
		cache.set(rootSessionId, views);
		return views;
	}
	return {
		get(rootSessionId) {
			return cache.get(rootSessionId);
		},
		refresh
	};
}

//#endregion
//#region src/collaboration/role-duty.ts
/** 协作命名空间（与 RecordStore/RoleStore 一致）。 */
const NAMESPACE = "collaboration";
/** 会话绑定目录名（collaboration/sessions/）。 */
const SESSIONS_DIR = "sessions";
/** 绑定文件路径：会话 id 哈希做文件名（只用于文件名，不产生权限）。 */
function bindingPath(dataDir, sessionId) {
	return join(dataDir, NAMESPACE, SESSIONS_DIR, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}
function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}
function isEnoent(error) {
	return typeof error === "object" && error !== null && error.code === "ENOENT";
}
/** 读绑定文件：没有/坏了/形状不对都当「没有绑定」（不抛）。 */
async function readBinding(dataDir, sessionId) {
	let text;
	try {
		text = await readFile(bindingPath(dataDir, sessionId), "utf8");
	} catch (error) {
		if (isEnoent(error)) return void 0;
		return;
	}
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof raw !== "object" || raw === null) return void 0;
	const record = raw;
	if (!isNonEmptyString(record.sessionId)) return void 0;
	if (!isNonEmptyString(record.rootSessionId)) return void 0;
	if (!isNonEmptyString(record.taskId)) return void 0;
	return {
		sessionId: record.sessionId,
		rootSessionId: record.rootSessionId,
		taskId: record.taskId
	};
}
/** 写绑定文件：临时文件 + rename 原子替换（半截文件不算绑定）。 */
async function writeBinding(dataDir, binding) {
	const path = bindingPath(dataDir, binding.sessionId);
	await mkdir(join(dataDir, NAMESPACE, SESSIONS_DIR), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	try {
		await writeFile(tmp, JSON.stringify(binding, null, 2), "utf8");
		await rename(tmp, path);
	} catch (error) {
		await rmQuiet(tmp);
		throw error;
	}
}
async function rmQuiet(path) {
	try {
		await rm(path, { force: true });
	} catch {}
}
/**
* 创建职责服务。缓存是加速层：盘上绑定 + 分工记录 + 角色模板才是事实源。
*/
function createRoleDutyService(deps) {
	const ttlMs = typeof deps.ttlMs === "number" && Number.isFinite(deps.ttlMs) && deps.ttlMs >= 0 ? deps.ttlMs : 3e4;
	const missTtlMs = typeof deps.missTtlMs === "number" && Number.isFinite(deps.missTtlMs) && deps.missTtlMs >= 0 ? deps.missTtlMs : 5e3;
	const cache = /* @__PURE__ */ new Map();
	const loading = /* @__PURE__ */ new Set();
	/** 反查职责：绑定 → 分工记录（sessions[].label = 角色名）→ 角色模板正文。 */
	const resolveDuty = async (sessionId) => {
		const binding = await readBinding(deps.dataDir, sessionId);
		if (binding === void 0) return void 0;
		const assignments = await deps.records.list(binding.rootSessionId, {
			taskId: binding.taskId,
			kind: "assignment"
		});
		let roleName;
		for (const record of assignments) {
			for (const link of record.sessions ?? []) if (link.sessionId === sessionId) {
				roleName = link.label;
				break;
			}
			if (roleName !== void 0) break;
		}
		if (roleName === void 0) return void 0;
		const role = await deps.roles.read(roleName);
		return {
			roleName,
			description: role.description.trim()
		};
	};
	return {
		get(sessionId) {
			const entry = cache.get(sessionId);
			if (entry === void 0) return void 0;
			return Date.now() - entry.at < (entry.duty === void 0 ? missTtlMs : ttlMs) ? entry.duty : void 0;
		},
		async refresh(sessionId) {
			if (loading.has(sessionId)) return this.get(sessionId);
			loading.add(sessionId);
			try {
				const duty = await resolveDuty(sessionId);
				cache.set(sessionId, {
					duty,
					at: Date.now()
				});
				return duty;
			} catch {
				cache.set(sessionId, {
					duty: void 0,
					at: Date.now()
				});
				return;
			} finally {
				loading.delete(sessionId);
			}
		},
		prime(sessionId, duty) {
			cache.set(sessionId, {
				duty,
				at: Date.now()
			});
		},
		async bind(input) {
			await writeBinding(deps.dataDir, {
				sessionId: input.sessionId,
				rootSessionId: input.rootSessionId,
				taskId: input.taskId
			});
		}
	};
}

//#endregion
//#region src/collaboration/model-switch.ts
const DIRECT_CODES = new Set([
	"NO_ADAPTER",
	"QUOTA",
	"ACCOUNT_QUOTA",
	"RATE_LIMIT",
	"TIMEOUT",
	"TRANSPORT",
	"SERVER"
]);
/** 命中则这一轮不前进，即使 status 是 429 或 5xx。INVALID_REQUEST 不在此表，单独按清单判断。 */
const EXCLUDED_CODES = new Set([
	"AUTH",
	"INVALID_CREDENTIAL",
	"MISSING_CREDENTIAL",
	"CONTEXT_WINDOW_EXCEEDED",
	"EMPTY_RESPONSE",
	"PI_AI_ERROR",
	"UNKNOWN",
	"IMAGE_OFFLOAD_REQUIRED",
	"STREAM_CLOSED",
	"MALFORMED_RESPONSE"
]);
function warn(error) {
	console.warn("[dsh-router] model switch failed:", error instanceof Error ? error.message : String(error));
}
function sessionIdOf(session) {
	if (typeof session !== "object" || session === null) return "";
	const id = session.id;
	return typeof id === "string" ? id : "";
}
function agentIdOf(agent) {
	if (typeof agent !== "object" || agent === null) return "";
	const id = agent.id;
	return typeof id === "string" ? id : "";
}
function classifyTurnError(error) {
	const code = typeof error.code === "string" ? error.code : "";
	if (DIRECT_CODES.has(code)) return "switch";
	if (code === "INVALID_REQUEST") return "invalid-request";
	if (EXCLUDED_CODES.has(code) || code.startsWith("HTTP_")) return "ignore";
	if (error.status === 429) return "switch";
	if (typeof error.status === "number" && error.status >= 500 && error.status <= 599) return "switch";
	return "ignore";
}
function toFailure(candidate, error) {
	const failure = {
		provider: candidate.provider,
		model: candidate.model,
		code: typeof error.code === "string" ? error.code : "",
		message: typeof error.message === "string" ? error.message : ""
	};
	if (typeof error.status === "number") failure.status = error.status;
	return failure;
}
function formatPair(candidate) {
	return `${candidate.provider}/${candidate.model}`;
}
function formatSequence(sequence) {
	return sequence.map(formatPair).join("、");
}
function formatFailure(failure) {
	const status = failure.status !== void 0 ? ` status=${failure.status}` : "";
	return `- ${failure.provider}/${failure.model}：code=${failure.code}${status} message=${failure.message}`;
}
async function modelListed(llm, provider, model) {
	if (llm === void 0 || typeof llm.listProviders !== "function" || typeof llm.listModels !== "function") return "unreadable";
	let providers;
	try {
		const listed = await llm.listProviders();
		if (!Array.isArray(listed)) return "unreadable";
		providers = listed;
	} catch {
		return "unreadable";
	}
	if (!providers.some((item) => item?.id === provider)) return "unreadable";
	try {
		const models = await llm.listModels(provider);
		if (!Array.isArray(models)) return "unreadable";
		return models.some((item) => item?.id === model) ? "present" : "missing";
	} catch {
		return "unreadable";
	}
}
function createModelSwitch(deps) {
	const { runs, records, signal } = deps;
	const commitPending = (run) => {
		if (run.pending === void 0) return;
		run.failures.push(run.pending);
		run.pending = void 0;
	};
	const markBlocked = async (run) => {
		try {
			await records.update(run.rootSessionId, run.taskId, run.taskId, { workLabel: "受阻" });
		} catch (error) {
			warn(error);
		}
		if (deps.activeTasks === void 0) return;
		try {
			await deps.activeTasks.refresh(run.rootSessionId);
		} catch (error) {
			warn(error);
		}
	};
	const writeReport = async (run, childId, title, body) => {
		try {
			await records.create(run.rootSessionId, {
				kind: "report",
				taskId: run.taskId,
				title,
				body,
				workLabel: "已报告",
				sessions: [{
					sessionId: childId,
					label: run.roleName
				}]
			});
		} catch (error) {
			warn(error);
		}
	};
	const stopUnsafe = async (run, childId, detail) => {
		run.phase = "stopped";
		const lines = [
			"不能安全地再自动走下一步。",
			`卡在候选：${formatPair(detail.stuck)}`,
			`select 已改模型：${detail.selectChanged ? "是" : "否"}`,
			`投递是否发生：${detail.delivered ? "是" : "否"}`,
			`最后一次错误：${detail.errorText}`,
			"未退回主会话模型。",
			"任务已标为受阻。"
		];
		if (detail.extra !== void 0 && detail.extra !== "") lines.push(detail.extra);
		await markBlocked(run);
		await writeReport(run, childId, "模型切换受阻", lines.join("\n"));
	};
	const stopExhausted = async (run, childId) => {
		commitPending(run);
		run.phase = "stopped";
		const last = run.failures[run.failures.length - 1];
		const lines = [
			"候选已用完，已停止。",
			"试过：",
			...run.failures.map(formatFailure),
			`最后一次错误：${last ? `${last.code} ${last.message}` : ""}`,
			"未退回主会话模型。",
			"未再投递继续。",
			"任务已标为受阻，等待用户决定。"
		];
		await markBlocked(run);
		await writeReport(run, childId, "模型切换受阻", lines.join("\n"));
	};
	const proceed = async (childId) => {
		const run = runs.get(childId);
		if (run === void 0 || run.phase !== "switching" || run.delivering === true || signal.aborted) return;
		if (run.index + 1 >= run.sequence.length) {
			run.delivering = true;
			try {
				if (signal.aborted || run.phase !== "switching") return;
				await stopExhausted(run, childId);
			} finally {
				run.delivering = false;
			}
			return;
		}
		const agents = deps.getAgents();
		if (agents === void 0) return;
		const agent = agents.get(childId);
		if (agent === void 0) {
			run.delivering = true;
			try {
				if (signal.aborted || run.phase !== "switching") return;
				commitPending(run);
				const stuck = run.sequence[run.index];
				await stopUnsafe(run, childId, {
					stuck,
					selectChanged: false,
					delivered: false,
					errorText: "没有在线子会话"
				});
			} finally {
				run.delivering = false;
			}
			return;
		}
		if (agent.status !== "idle") return;
		if (agents.get(childId)?.status !== "idle") return;
		run.delivering = true;
		let successReport;
		try {
			if (signal.aborted || run.phase !== "switching") return;
			const modelApi = agent.model;
			if (modelApi === void 0 || typeof modelApi.select !== "function") {
				commitPending(run);
				await stopUnsafe(run, childId, {
					stuck: run.sequence[run.index],
					selectChanged: false,
					delivered: false,
					errorText: "宿主没有 agent.model.select",
					extra: "宿主没有 agent.model.select。"
				});
				return;
			}
			const from = run.sequence[run.index];
			const failure = run.pending;
			let chosen = -1;
			let selectError;
			for (let index = run.index + 1; index < run.sequence.length; index++) {
				if (signal.aborted || run.phase !== "switching") return;
				const candidate = run.sequence[index];
				try {
					await modelApi.select({
						provider: candidate.provider,
						model: candidate.model
					});
					chosen = index;
					break;
				} catch (error) {
					selectError = error;
				}
			}
			if (signal.aborted || run.phase !== "switching") return;
			if (chosen < 0) {
				commitPending(run);
				await stopUnsafe(run, childId, {
					stuck: run.sequence[run.index + 1] ?? from,
					selectChanged: false,
					delivered: false,
					errorText: selectError instanceof Error ? selectError.message : String(selectError)
				});
				return;
			}
			const to = run.sequence[chosen];
			const parent = agents.get(run.parentSessionId);
			if (parent === void 0) {
				commitPending(run);
				run.index = chosen;
				await stopUnsafe(run, childId, {
					stuck: to,
					selectChanged: true,
					delivered: false,
					errorText: "没有在线父会话",
					extra: "已改模型，未能取得在线父会话，未投递。"
				});
				return;
			}
			const text = `已从 ${from.provider}/${from.model} 换到 ${to.provider}/${to.model}，继续原任务。`;
			const subagents = deps.getSubagents();
			if (subagents?.sendMessage === void 0) {
				commitPending(run);
				run.index = chosen;
				await stopUnsafe(run, childId, {
					stuck: to,
					selectChanged: true,
					delivered: false,
					errorText: "宿主缺少向子会话投递的能力"
				});
				return;
			}
			try {
				await subagents.sendMessage(parent, childId, [{
					type: "text",
					text
				}], { signal });
			} catch (error) {
				commitPending(run);
				run.index = chosen;
				await stopUnsafe(run, childId, {
					stuck: to,
					selectChanged: true,
					delivered: false,
					errorText: error instanceof Error ? error.message : String(error)
				});
				return;
			}
			commitPending(run);
			run.index = chosen;
			run.phase = "armed";
			run.failedTurn = void 0;
			const reported = failure ?? run.failures[run.failures.length - 1];
			const statusLine = reported?.status !== void 0 ? `状态：${reported.status}\n` : "";
			successReport = {
				title: "模型切换",
				body: [
					`已从 ${from.provider}/${from.model} 换到 ${to.provider}/${to.model}。`,
					`错误码：${reported?.code ?? ""}`,
					`${statusLine}错误信息：${reported?.message ?? ""}`,
					`本次序列（本次随机起点轮转后的实际顺序）：${formatSequence(run.sequence)}`,
					`已经放弃的前缀：${formatSequence(run.sequence.slice(0, chosen))}`,
					"未退回主会话模型。"
				].join("\n")
			};
		} finally {
			run.delivering = false;
		}
		if (successReport !== void 0 && !signal.aborted) await writeReport(run, childId, successReport.title, successReport.body);
	};
	const arm = (run, turn, failure) => {
		run.phase = "switching";
		run.failedTurn = turn;
		run.pending = failure;
	};
	return {
		async onSessionEvent(session, event) {
			const childId = sessionIdOf(session);
			const run = runs.get(childId);
			if (run === void 0 || run.phase === "stopped" || signal.aborted) return;
			if (typeof event !== "object" || event === null) return;
			const record = event;
			if (record.type === "turn/start") {
				if ((run.phase === "switching" || run.phase === "checking") && typeof record.turn === "number" && run.failedTurn !== void 0 && record.turn > run.failedTurn) {
					run.phase = "armed";
					run.pending = void 0;
					run.failedTurn = void 0;
				}
				return;
			}
			if (record.type !== "turn/end" || run.phase !== "armed") return;
			const reason = record.reason;
			if (typeof reason !== "object" || reason === null) return;
			if (reason.kind !== "error") return;
			const error = reason.error;
			if (typeof error !== "object" || error === null) return;
			const turnError = error;
			const current = run.sequence[run.index];
			if (current === void 0) return;
			const kind = classifyTurnError(turnError);
			if (kind === "ignore") return;
			const turn = typeof record.turn === "number" ? record.turn : 0;
			const failure = toFailure(current, turnError);
			if (kind === "invalid-request") {
				run.phase = "checking";
				run.failedTurn = turn;
				run.pending = failure;
				const verdict = await modelListed(deps.getLlm(), current.provider, current.model);
				const latest = runs.get(childId);
				if (latest === void 0 || latest.phase !== "checking" || latest.failedTurn !== turn || signal.aborted) return;
				if (verdict !== "missing") {
					latest.phase = "armed";
					latest.pending = void 0;
					latest.failedTurn = void 0;
					return;
				}
				latest.phase = "switching";
				await proceed(childId);
				return;
			}
			arm(run, turn, failure);
			await proceed(childId);
		},
		async onAgentStatus(payload) {
			if (typeof payload !== "object" || payload === null || signal.aborted) return;
			const record = payload;
			if (record.status !== "idle") return;
			const childId = agentIdOf(record.agent);
			if (childId === "") return;
			await proceed(childId);
		},
		async onAgentsAvailable() {
			if (signal.aborted) return;
			const pending = [...runs.keys()];
			for (const childId of pending) await proceed(childId);
		}
	};
}

//#endregion
//#region src/entry.ts
/** Loader 行与诊断里看到的插件名（裸包名，与 cordis.patch.yml 的行一致）。 */
const name = "@goodjin2/dsh-router";
/**
* 根服务不 require 任何旧宿主服务：它只 provide 一个纯内存运行时。llm 是模型切换的
* 可选依赖（机会式注入），不进全局必需数组——否则缺席时整行装载失败、CLI 记录/工具
* 服务也被拖死（brief：不能 required 使 CLI 不可用）。工作台路由所需的 webServer/connection
* 已移到独立 workbench 行的必需 inject 里。
*/
const inject = [];
/** 根配置：只有 dataDir，全部可缺省（缺省 DSH_HOME/router，运行时解析一次）。 */
const Config = Schema.object({ dataDir: Schema.string().default("") });
/**
* 装载入口：组装根服务并 provide，接线模型切换与会话事件。标准 Cordis 生命周期——
* 返回注销器（存储单实例随 fiber 销毁自然回收；保留 disposer 形状）。
*/
function apply(ctx, rawConfig) {
	const config = rawConfig ?? {};
	const runtime = createCollaborationRuntime({ dataDir: typeof config.dataDir === "string" ? config.dataDir : void 0 });
	const childModelRuns = /* @__PURE__ */ new Map();
	const face = {
		records: runtime.records,
		roles: runtime.roles,
		dataDir: runtime.dataDir,
		activeTasks: createActiveTaskCache(runtime.records),
		roleDuties: createRoleDutyService({
			dataDir: runtime.dataDir,
			records: runtime.records,
			roles: runtime.roles
		}),
		childModelRuns
	};
	const released = (!!ctx.root?.provide ? ctx.root.provide.bind(ctx.root) : ctx.provide.bind(ctx))("routerCollaboration", face);
	const disposeService = typeof released === "function" ? released : () => {};
	runtime.roles.migrateLegacyJson().then(() => seedPresetRoles(runtime.roles)).catch((error) => {
		console.warn("[dsh-router] migrate/seed roles failed:", error instanceof Error ? error.message : String(error));
	});
	const watcher = new AbortController();
	let llmFace;
	let agentsFace;
	let subagentsFace;
	const switcher = createModelSwitch({
		runs: childModelRuns,
		records: runtime.records,
		activeTasks: face.activeTasks,
		signal: watcher.signal,
		getAgents: () => agentsFace,
		getSubagents: () => subagentsFace,
		getLlm: () => llmFace
	});
	const fibers = [];
	const track = (fiber) => {
		if (typeof fiber === "object" && fiber !== null) fibers.push(fiber);
	};
	const warnSwitch = (error) => {
		console.warn("[dsh-router] model switch failed:", error instanceof Error ? error.message : String(error));
	};
	track(ctx.inject?.(["llm"], (child) => {
		const llm = child.llm;
		if (llm !== void 0 && typeof llm.listProviders === "function" && typeof llm.listModels === "function") llmFace = llm;
	}));
	track(ctx.inject?.(["agents", "subagents"], (child) => {
		const got = child;
		agentsFace = got.agents;
		subagentsFace = got.subagents;
		switcher.onAgentsAvailable().catch(warnSwitch);
	}));
	const offs = [];
	const host = ctx;
	if (typeof host.on === "function") {
		const offEvent = host.on("session/event", (session, event) => {
			switcher.onSessionEvent(session, event).catch(warnSwitch);
		});
		const offStatus = host.on("agent/status", (payload) => {
			switcher.onAgentStatus(payload).catch(warnSwitch);
		});
		if (typeof offEvent === "function") offs.push(() => {
			offEvent();
		});
		if (typeof offStatus === "function") offs.push(() => {
			offStatus();
		});
	}
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		watcher.abort();
		for (const off of offs) try {
			off();
		} catch (error) {
			warnSwitch(error);
		}
		for (const fiber of fibers) try {
			const result = fiber.dispose?.();
			if (result !== void 0 && typeof result.then === "function") result.catch(() => {});
		} catch (error) {
			warnSwitch(error);
		}
		try {
			disposeService();
		} catch (error) {
			warnSwitch(error);
		}
	};
}

//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=entry.js.map