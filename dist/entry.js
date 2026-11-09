import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { createZstdDecompress } from "node:zlib";
import { existsSync, globSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

//#region rolldown:runtime
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function() {
	return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (all) => {
	let target = {};
	for (var name$1 in all) __defProp(target, name$1, {
		get: all[name$1],
		enumerable: true
	});
	return target;
};

//#endregion
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
//#region src/host/ledger/errors.ts
/** 账本域统一错误。 */
var LedgerError = class extends Error {
	/** 错误码，调用方以此分流。 */
	code;
	constructor(code, message, options) {
		super(message, options);
		this.name = "LedgerError";
		this.code = code;
	}
};

//#endregion
//#region src/host/ledger/machine.ts
/** 合法迁移表：from → 允许的 to 闭包集合（照计划逐条列出）。 */
const TRANSITIONS = {
	draft: [
		"queued",
		"blocked",
		"cancelled"
	],
	queued: [
		"dispatched",
		"blocked",
		"cancelled"
	],
	dispatched: [
		"running",
		"completed",
		"review-pending",
		"paused",
		"blocked",
		"failed",
		"cancelled"
	],
	running: [
		"waiting-user",
		"blocked",
		"paused",
		"review-pending",
		"completed",
		"failed",
		"cancelled"
	],
	"waiting-user": [
		"running",
		"blocked",
		"failed",
		"cancelled"
	],
	blocked: [
		"running",
		"failed",
		"cancelled"
	],
	paused: ["running", "cancelled"],
	"review-pending": ["completed", "cancelled"],
	completed: [],
	cancelled: [],
	failed: []
};
/** 判断 from→to 是否合法迁移。 */
function canTransition(from, to) {
	return TRANSITIONS[from]?.includes(to) ?? false;
}
/** 断言 from→to 合法；非法抛 LedgerError('illegal-transition')，消息带 from→to。 */
function assertTransition(from, to) {
	if (!canTransition(from, to)) throw new LedgerError("illegal-transition", `非法状态迁移: ${from} → ${to}`);
}

//#endregion
//#region src/host/ledger/store.ts
/** ID 格式：T-%03d，项目内单调。 */
function formatTaskId(n) {
	return `T-${String(n).padStart(3, "0")}`;
}
/**
* 在依赖图（含新建节点）上 DFS 找环，返回环路径（首尾同节点），无环返回 null。
* 未创建的依赖 ID 没有出边，不参与成环。
*/
function findDependencyCycle(edges, start) {
	const visiting = /* @__PURE__ */ new Set();
	const done = /* @__PURE__ */ new Set();
	const stack = [];
	const visit = (node) => {
		if (visiting.has(node)) {
			const from = stack.indexOf(node);
			return [...stack.slice(from), node];
		}
		if (done.has(node)) return null;
		visiting.add(node);
		stack.push(node);
		for (const dep of edges.get(node) ?? []) {
			const cycle = visit(dep);
			if (cycle) return cycle;
		}
		stack.pop();
		visiting.delete(node);
		done.add(node);
		return null;
	};
	return visit(start);
}
/** 任务账本：任务的内存权威状态 + 注入式持久化。 */
var TaskLedger = class {
	persistence;
	clock;
	tasks = [];
	nextTaskNumber = 1;
	questions = [];
	loaded = false;
	loadPromise;
	/** 写串行化链：所有 commit 依次排队，杜绝并发写互抹与 save 乱序覆盖。 */
	writeChain = Promise.resolve();
	constructor(persistence, clock = Date.now) {
		this.persistence = persistence;
		this.clock = clock;
	}
	/** 首次访问时从持久化装载（构造函数保持同步）。 */
	async ensureLoaded() {
		if (this.loaded) return Promise.resolve();
		this.loadPromise ??= this.loadFromPersistence().then(() => {
			this.loaded = true;
		});
		return this.loadPromise;
	}
	async loadFromPersistence() {
		const file = await this.persistence.load();
		if (file) {
			this.tasks = structuredClone(file.tasks);
			this.nextTaskNumber = file.nextTaskNumber;
			this.questions = file.questions ?? [];
		}
	}
	/** 当前状态的落盘快照（深拷贝，之后内存再变不影响这份）。 */
	currentFile() {
		return {
			schemaVersion: 1,
			tasks: structuredClone(this.tasks),
			nextTaskNumber: this.nextTaskNumber,
			questions: structuredClone(this.questions)
		};
	}
	/**
	* 写操作统一通道：备份 → 校验并变更内存（校验抛错则状态未动、不触发保存）
	* → 保存新状态 → 保存失败回滚内存并抛 persistence-failed。
	*/
	commit(mutate) {
		const run = this.writeChain.then(async () => {
			await this.ensureLoaded();
			const backupTasks = structuredClone(this.tasks);
			const backupNext = this.nextTaskNumber;
			const backupQuestions = structuredClone(this.questions);
			let value;
			try {
				value = mutate();
				await this.persistence.save(this.currentFile());
			} catch (cause) {
				this.tasks = backupTasks;
				this.nextTaskNumber = backupNext;
				this.questions = backupQuestions;
				if (cause instanceof LedgerError) throw cause;
				throw new LedgerError("persistence-failed", `账本保存失败，内存已回滚: ${String(cause)}`, { cause });
			}
			return value;
		});
		this.writeChain = run.then(() => void 0, () => void 0);
		return run;
	}
	/** 串行只读判定：与写共用一条链保证一致性，但不保存（纯幂等无变更不落盘）。 */
	readLocked(fn) {
		const run = this.writeChain.then(async () => {
			await this.ensureLoaded();
			return fn();
		});
		this.writeChain = run.then(() => void 0, () => void 0);
		return run;
	}
	/** 取任务，不存在抛 task-not-found。 */
	mustGet(id) {
		const task = this.tasks.find((t) => t.id === id);
		if (!task) throw new LedgerError("task-not-found", `任务不存在: ${id}`);
		return task;
	}
	/** 按创建序拿全量任务。 */
	async listAll() {
		await this.ensureLoaded();
		return [...this.tasks];
	}
	/** 按创建序拿未结束（非终态）任务。 */
	async listActive() {
		await this.ensureLoaded();
		return this.tasks.filter((t) => !isTerminal(t.status));
	}
	/** 同步读取任务（先任意 await 过一次账本方法再调用，保证已装载）。 */
	get(id) {
		return this.tasks.find((t) => t.id === id);
	}
	/** 创建任务：分配单调 ID、依赖图查环；依赖未满足落 queued，否则 draft。 */
	async createTask(input) {
		const dependsOn = input.dependsOn ?? [];
		return this.commit(() => {
			const id = formatTaskId(this.nextTaskNumber);
			const edges = new Map(this.tasks.map((t) => [t.id, t.dependsOn]));
			edges.set(id, dependsOn);
			const cycle = findDependencyCycle(edges, id);
			if (cycle) throw new LedgerError("dependency-cycle", `依赖环: ${cycle.join(" → ")}`);
			const depsSatisfied = dependsOn.every((depId) => {
				const dep = this.tasks.find((t) => t.id === depId);
				return dep !== void 0 && dep.status === "completed";
			});
			const now = this.clock();
			const record = {
				id,
				title: input.title,
				goal: input.goal,
				acceptance: input.acceptance ?? [],
				constraints: input.constraints ?? [],
				projectId: input.projectId,
				cwd: input.cwd,
				role: input.role,
				templateId: input.templateId,
				parentId: input.parentId,
				dispatchedBySessionId: input.dispatchedBySessionId,
				dependsOn,
				status: depsSatisfied ? "draft" : "queued",
				docVersion: 1,
				retryCount: 0,
				acceptancePolicy: input.acceptancePolicy ?? "auto",
				createdAt: now,
				updatedAt: now
			};
			this.tasks.push(record);
			this.nextTaskNumber += 1;
			return record;
		});
	}
	/**
	* 状态迁移：照状态机表校验，非法抛 illegal-transition。
	* reason 仅为调用侧审计保留，账本内不落独立字段。
	*/
	async transition(id, to, reason) {
		return this.commit(() => {
			const task = this.mustGet(id);
			assertTransition(task.status, to);
			task.status = to;
			task.updatedAt = this.clock();
			return task;
		});
	}
	/** 绑定 worker 会话（默认一个任务一个会话）。 */
	async attachSession(id, sessionId) {
		return this.commit(() => {
			const task = this.mustGet(id);
			task.sessionId = sessionId;
			task.updatedAt = this.clock();
			return task;
		});
	}
	/**
	* 记录任务执行会话首请求的缓存命中量（v1.3 C1，规格 §4）。一次性语义：
	* 已有值不覆盖——观察器只对首条 assistant/message 调用，账本层再兜一道底。
	*/
	async recordFirstCacheRead(id, tokens) {
		return this.commit(() => {
			const task = this.mustGet(id);
			if (task.firstRequestCacheReadTokens === void 0) {
				task.firstRequestCacheReadTokens = tokens;
				task.updatedAt = this.clock();
			}
			return task;
		});
	}
	/** 更新一句话进度（worker 汇报）。 */
	async updateProgress(id, text) {
		return this.commit(() => {
			const task = this.mustGet(id);
			task.progress = text;
			task.updatedAt = this.clock();
			return task;
		});
	}
	/** 补充约束：docVersion+1、约束追加（活动短卡的「最新补充约束」来源）。 */
	async supplement(id, additions) {
		return this.commit(() => {
			const task = this.mustGet(id);
			if (isTerminal(task.status)) throw new LedgerError("illegal-transition", `终态任务不可补充: ${task.id}（${task.status}）`);
			task.docVersion += 1;
			task.constraints.push(...additions);
			task.updatedAt = this.clock();
			return task.docVersion;
		});
	}
	/**
	* 完成申请。校验：调用版本必须等于当前 docVersion（否则 stale-version）。
	* 幂等：completed / review-pending 上同版本重复提交返回首次记录，不落盘。
	* 策略：auto 且无未结子任务 → completed；否则 → review-pending。
	*/
	async complete(id, input) {
		const decision = await this.readLocked(() => {
			const task = this.mustGet(id);
			if (input.docVersion !== task.docVersion) throw new LedgerError("stale-version", `完成提交版本 v${input.docVersion} 与当前任务版本 v${task.docVersion} 不符: ${id}`);
			if (task.status === "completed") return {
				task,
				write: false
			};
			const openSubtasks = this.tasks.filter((t) => t.parentId === id && !isTerminal(t.status));
			const canComplete = task.acceptancePolicy === "auto" && openSubtasks.length === 0;
			if (task.status === "review-pending" && task.result && !canComplete) return {
				task,
				write: false
			};
			return {
				task,
				write: true
			};
		});
		if (!decision.write) return decision.task;
		return this.commit(() => {
			const task = this.mustGet(id);
			if (input.docVersion !== task.docVersion) throw new LedgerError("stale-version", `完成提交版本 v${input.docVersion} 与当前任务版本 v${task.docVersion} 不符: ${id}`);
			if (task.status === "completed") return task;
			const openSubtasks = this.tasks.filter((t) => t.parentId === id && !isTerminal(t.status));
			const canComplete = task.acceptancePolicy === "auto" && openSubtasks.length === 0;
			if (task.status === "review-pending" && task.result) {
				if (canComplete) {
					assertTransition(task.status, "completed");
					task.status = "completed";
					task.updatedAt = this.clock();
				}
				return task;
			}
			const target = canComplete ? "completed" : "review-pending";
			assertTransition(task.status, target);
			task.result = {
				summary: input.summary,
				docRef: input.docRef,
				deliverables: input.deliverables,
				acceptanceEvidence: input.acceptanceEvidence,
				openIssues: input.openIssues,
				...input.deliveryOrigin !== void 0 ? { deliveryOrigin: input.deliveryOrigin } : {},
				completedAt: this.clock()
			};
			task.status = target;
			task.updatedAt = this.clock();
			return task;
		});
	}
	/** 验收通过：review-pending → completed（by 仅为审计语义，账本不落字段）。 */
	async accept(id, by) {
		return this.commit(() => {
			const task = this.mustGet(id);
			assertTransition(task.status, "completed");
			task.status = "completed";
			task.updatedAt = this.clock();
			return task;
		});
	}
	/**
	* 驳回返工：review-pending → running，note 落 progress（worker 第一眼要看的文字）。
	* 状态机表里没有 review-pending→running 边（计划 Task 1 明注「驳回不走表边」）：
	* 驳回是完成协议的专属操作，只认 review-pending 起点，其余起点照抛非法迁移。
	*/
	async reject(id, note) {
		return this.commit(() => {
			const task = this.mustGet(id);
			if (task.status !== "review-pending") throw new LedgerError("illegal-transition", `驳回仅适用于 review-pending: ${id}（当前 ${task.status}）`);
			task.status = "running";
			task.progress = note;
			task.updatedAt = this.clock();
			return task;
		});
	}
	/**
	* 退回重做（需求 §14.2 完成卡动作）：completed → running，note 落 progress。
	* 与 reject 同款「完成协议专属操作不走表边」：终态在迁移表里仍无出边，
	* 只有用户经完成卡发起的 rework 能把已完成任务 reopen。
	*/
	async rework(id, note) {
		return this.commit(() => {
			const task = this.mustGet(id);
			if (task.status !== "completed") throw new LedgerError("illegal-transition", `退回重做仅适用于 completed: ${id}（当前 ${task.status}）`);
			task.status = "running";
			task.progress = note;
			task.updatedAt = this.clock();
			return task;
		});
	}
	/** 取消：进终态 cancelled。 */
	async cancel(id, reason) {
		return this.commit(() => {
			const task = this.mustGet(id);
			assertTransition(task.status, "cancelled");
			task.status = "cancelled";
			task.updatedAt = this.clock();
			return task;
		});
	}
	/** 失败收场：进终态 failed。 */
	async fail(id, reason) {
		return this.commit(() => {
			const task = this.mustGet(id);
			assertTransition(task.status, "failed");
			task.status = "failed";
			task.updatedAt = this.clock();
			return task;
		});
	}
	/** 报告阻塞：→ blocked，reason 落 progress。 */
	async reportBlocker(id, reason) {
		return this.commit(() => {
			const task = this.mustGet(id);
			assertTransition(task.status, "blocked");
			task.status = "blocked";
			task.progress = reason;
			task.updatedAt = this.clock();
			return task;
		});
	}
	/**
	* 派发失败记账（v1.1 规格 §2-4）：retryCount+1、错误文本落 progress，任务保持
	* 原状态（draft/queued —— 不产生 cancelled + 无会话残留）；累计达 blockAt
	* （默认 3）自动 → blocked 并返回封顶后的记录，由调用方通知 Router。
	* 幂等口径：已 blocked 的任务再记账不重复迁移（评审修复——并发下不抛
	* blocked→blocked），retryCount 停在上限，错误文本照常更新。
	*/
	async recordDispatchFailure(id, reason, opts) {
		return this.commit(() => {
			const task = this.mustGet(id);
			const blockAt = opts?.blockAt ?? 3;
			const nextCount = (task.retryCount ?? 0) + 1;
			if (nextCount >= blockAt && task.status !== "blocked") assertTransition(task.status, "blocked");
			task.retryCount = task.status === "blocked" ? Math.min(nextCount, blockAt) : nextCount;
			task.progress = reason;
			task.updatedAt = this.clock();
			if (nextCount >= blockAt && task.status !== "blocked") task.status = "blocked";
			return task;
		});
	}
	/** 记一条待答问题（问答桥认领时落库，重启后孤儿恢复的依据）。 */
	async addQuestion(record) {
		return this.commit(() => {
			this.questions.push(structuredClone(record));
			return record;
		});
	}
	/** 问题了结（answered / expired）；找不到返回 undefined。 */
	async settleQuestion(id, status, answer) {
		return this.commit(() => {
			const record = this.questions.find((q) => q.id === id);
			if (record === void 0) return void 0;
			record.status = status;
			if (answer !== void 0) record.answer = answer;
			record.answeredAt = this.clock();
			return record;
		});
	}
	/** 全部 open 状态的问题（重启孤儿恢复扫描用）。 */
	async openQuestions() {
		await this.ensureLoaded();
		return this.questions.filter((q) => q.status === "open");
	}
	/** 按 ID 找问题（任意状态；应答桥区分 404/409 用）。 */
	async findQuestion(id) {
		await this.ensureLoaded();
		return this.questions.find((q) => q.id === id);
	}
	/**
	* 某任务已认领的提问批次数（v1.1 C6 提问预算的计数面）：认领即落一条记录，
	* 已答/失效都占预算——预算按「批次」计，不看批次的最终去向。
	*/
	async countTaskQuestions(taskId) {
		await this.ensureLoaded();
		return this.questions.filter((q) => q.taskId === taskId).length;
	}
};

//#endregion
//#region src/host/docs/task-docs.ts
/** result.md 的 Markdown 渲染：五字段齐全。 */
function renderResult(taskId, result) {
	const deliverables = result.deliverables ?? [];
	const openIssues = result.openIssues ?? [];
	return [
		`# 任务结果 ${taskId}`,
		"",
		"## 结果摘要",
		result.summary,
		"",
		"## 交付物",
		deliverables.length > 0 ? deliverables.map((d) => `- ${d}`).join("\n") : "无",
		"",
		"## 验收依据",
		result.acceptanceEvidence ?? "无",
		"",
		"## 遗留问题",
		openIssues.length > 0 ? openIssues.map((d) => `- ${d}`).join("\n") : "无",
		"",
		"## 完成时间",
		result.completedAt !== void 0 ? new Date(result.completedAt).toISOString() : "未知",
		""
	].join("\n");
}
/** 任务文档存储：tasks/<ID>/ 下的版本化文档读写。 */
var TaskDocStore = class {
	rootDir;
	fs;
	constructor(rootDir, fs) {
		this.rootDir = rootDir;
		this.fs = fs;
	}
	/** 拼路径（不用 node:path，保持零宿主依赖）。 */
	join(...parts) {
		return parts.filter((p) => p !== "").join("/");
	}
	taskDir(taskId) {
		return this.join(this.rootDir, "tasks", taskId);
	}
	/** 文档路径；带版本时为 <name>.v<N>.md（如 task.v2.md），否则 <name>.md。 */
	docPath(taskId, name$1, version) {
		const file = version !== void 0 ? `${name$1}.v${version}.md` : `${name$1}.md`;
		return this.join(this.rootDir, "tasks", taskId, file);
	}
	/** 初始化任务书：写 task.v1.md；已存在抛 doc-exists（原始任务书不可变）。 */
	async initTask(task, book) {
		const path = this.docPath(task.id, "task", 1);
		await this.fs.mkdirp(this.taskDir(task.id));
		if (await this.fs.exists(path)) throw new LedgerError("doc-exists", `任务书已存在，拒绝覆盖: ${path}`);
		await this.fs.writeFile(path, book);
		return path;
	}
	/**
	* 补充要求：以 fromVersion 文件为底，生成 v{fromVersion+1}——「v N 补充」节 +
	* 原文，旧文件字节不动。底版不存在抛 doc-not-found；目标版已存在抛 doc-exists。
	*/
	async supplement(taskId, fromVersion, additions) {
		const fromPath = this.docPath(taskId, "task", fromVersion);
		if (!await this.fs.exists(fromPath)) throw new LedgerError("doc-not-found", `任务书版本不存在: ${fromPath}`);
		const next = fromVersion + 1;
		const nextPath = this.docPath(taskId, "task", next);
		if (await this.fs.exists(nextPath)) throw new LedgerError("doc-exists", `任务书版本已存在，疑似并发补充: ${nextPath}`);
		const original = await this.fs.readFile(fromPath);
		const body = additions.length > 0 ? additions.map((a) => `- ${a}`).join("\n") : "（无新增内容）";
		await this.fs.writeFile(nextPath, `${original}\n\n## v${next} 补充\n\n${body}\n`);
		return next;
	}
	/** 写当前进展（覆写语义）。 */
	async writeProgress(taskId, text) {
		const path = this.docPath(taskId, "progress");
		await this.fs.mkdirp(this.taskDir(taskId));
		await this.fs.writeFile(path, text);
		return path;
	}
	/** 写最终交付报告 result.md，返回路径。 */
	async writeResult(taskId, result) {
		const path = this.docPath(taskId, "result");
		await this.fs.mkdirp(this.taskDir(taskId));
		await this.fs.writeFile(path, renderResult(taskId, result));
		return path;
	}
	/** 读文档；不存在抛 doc-not-found。 */
	async readDoc(taskId, name$1, version) {
		const path = this.docPath(taskId, name$1, version);
		if (!await this.fs.exists(path)) throw new LedgerError("doc-not-found", `文档不存在: ${path}`);
		return this.fs.readFile(path);
	}
};

//#endregion
//#region src/host/ledger/scheduler.ts
/** 调度就绪判定器。 */
var Scheduler = class {
	ledger;
	/** 主管递归派发的最大深度（根任务深度 1 的话就是 maxDepth 层）。 */
	maxDepth;
	/** 按 worker 类型的并发上限（Part B 派发队列消费；判定层暂不裁剪）。 */
	concurrency;
	constructor(ledger, opts) {
		this.ledger = ledger;
		this.maxDepth = opts.maxDepth;
		this.concurrency = opts.concurrency;
	}
	/** 依赖是否全部 completed（依赖不存在视为未满足，不就绪）。 */
	depsComplete(task, byId) {
		return task.dependsOn.every((depId) => byId.get(depId)?.status === "completed");
	}
	/** 当前可投递的任务：queued 且 dependsOn 全 completed，按创建序。 */
	async readyTasks() {
		const all = await this.ledger.listAll();
		const byId = new Map(all.map((t) => [t.id, t]));
		return all.filter((t) => t.status === "queued" && this.depsComplete(t, byId));
	}
	/** 任务完成后新解锁的任务（依赖它、已 queued、其余依赖也全部完成），按创建序。 */
	async onCompleted(taskId) {
		const all = await this.ledger.listAll();
		const byId = new Map(all.map((t) => [t.id, t]));
		return all.filter((t) => t.status === "queued" && t.dependsOn.includes(taskId) && this.depsComplete(t, byId));
	}
	/**
	* 派发把关，判定顺序：权限（worker 禁止派发；主管之下禁再派主管——v1.1 规格
	* §3.4）→ 结构（依赖命中祖先链即环风险）→ 容量（新任务深度 parent.depth+1 超
	* maxDepth）。环先于深度：结构性错误与深度无关，无论哪层都不该派。祖先链走
	* 账本的同步 get，需在账本已装载（先 await 过任一账本方法）后调用。
	*/
	dispatchGuard(parent, target) {
		if (parent.sessionIdRole === "worker") return {
			ok: false,
			code: "role-forbidden"
		};
		if (parent.sessionIdRole === "supervisor" && target.role === "supervisor") return {
			ok: false,
			code: "role-forbidden"
		};
		if (target.dependsOn !== void 0 && target.dependsOn.length > 0 && parent.parentTaskId !== void 0) {
			const ancestors = /* @__PURE__ */ new Set();
			let cursor = parent.parentTaskId;
			while (cursor !== void 0 && !ancestors.has(cursor)) {
				ancestors.add(cursor);
				cursor = this.ledger.get(cursor)?.parentId;
			}
			if (target.dependsOn.some((depId) => ancestors.has(depId))) return {
				ok: false,
				code: "cycle-risk"
			};
		}
		if (parent.depth + 1 > this.maxDepth) return {
			ok: false,
			code: "depth-exceeded"
		};
		return { ok: true };
	}
};

//#endregion
//#region src/host/model-ref.ts
function parseModelRef(ref) {
	if (typeof ref !== "string") return void 0;
	const slashAt = ref.indexOf("/");
	if (slashAt <= 0 || slashAt >= ref.length - 1) return void 0;
	const provider = ref.slice(0, slashAt);
	const model = ref.slice(slashAt + 1);
	return provider.trim() === "" || model.trim() === "" ? void 0 : {
		provider,
		model
	};
}

//#endregion
//#region src/host/guard/classify.ts
/** 错误对象上的分类标（bridge 失败路径写入）。 */
const FAILURE_CLASS_KEY = "failureClass";
/** 打标时记的失败阶段（会话创建/登记/投递），诊断用。 */
const FAILURE_STAGE_KEY = "failureStage";
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* 会话桥打标：把宿主调用面（create / attachSession / rename / prompt）的失败
* 标成 infra。返回同一个错误（原样再抛，只多两个不可枚举无关字段）。
*/
function tagInfraFailure(error, stage) {
	const err = error instanceof Error ? error : new Error(String(error));
	Object.assign(err, {
		[FAILURE_CLASS_KEY]: "infra",
		[FAILURE_STAGE_KEY]: stage
	});
	return err;
}
/** 分类：读到标用标；否则 LedgerError 域内拒绝为 task（持久化失败除外）；未知按 infra。 */
function classifyDispatchFailure(error) {
	const detail = messageOf(error);
	const tagged = error?.failureClass;
	if (tagged === "infra" || tagged === "task") {
		const stage = error?.failureStage;
		return {
			class: tagged,
			detail: typeof stage === "string" && stage !== "" ? `${stage}: ${detail}` : detail
		};
	}
	if (error instanceof LedgerError) return {
		class: error.code === "persistence-failed" ? "infra" : "task",
		detail
	};
	return {
		class: "infra",
		detail
	};
}

//#endregion
//#region src/host/tools/index.ts
/** 全集（注册与矩阵校验的基准顺序）。 */
const TOOL_NAMES = [
	"dispatch_task",
	"supplement_task",
	"query_tasks",
	"control_task",
	"search_history",
	"report_progress",
	"complete_task",
	"report_blocker",
	"list_worker_types",
	"create_worker_type"
];
/** 角色 → 工具白名单（v1.1 C2 起 router 增类型两件；router 无 complete，worker 无派发）。 */
const ROLE_TOOLS = {
	router: [
		"dispatch_task",
		"supplement_task",
		"query_tasks",
		"control_task",
		"search_history",
		"list_worker_types",
		"create_worker_type"
	],
	supervisor: [
		"dispatch_task",
		"supplement_task",
		"query_tasks",
		"control_task",
		"search_history",
		"report_progress",
		"complete_task"
	],
	worker: [
		"report_progress",
		"complete_task",
		"report_blocker"
	]
};
/** 角色的工具白名单（依基准顺序）。 */
function toolsForRole(role) {
	return TOOL_NAMES.filter((name$1) => ROLE_TOOLS[role].includes(name$1));
}
/** 一个编排工具的注册描述（身份卡/切换卡的工具清单与注册面同源，不设第二份文本）。 */
function orchestrationToolDescription(name$1) {
	return TOOL_SPECS[name$1].description;
}
/** 执行类工具：操作者必须是任务绑定的会话（规格 §7「调用者是当前任务执行者」）。 */
const EXECUTOR_TOOLS = [
	"report_progress",
	"complete_task",
	"report_blocker"
];
/**
* 角色×工具校验（计划 Task B3 纯函数）。
*
* 校验顺序：工具名 → 角色矩阵 → 任务归属（仅执行类；taskId 缺省时跳过归属，
* 由核心在读取任务时兜底）。「操作自己名下任务」按角色分流：执行类按
* sessionId 匹配；编排类（supplement/control/dispatch/query）只要求非 worker
* 角色——任务不记录创建者会话，v1 无跨 Router 隔离。
*/
function assertCallerRole(role, tool, callerSessionId$1, ledger, taskId) {
	if (!TOOL_NAMES.includes(tool)) throw new LedgerError("unknown-tool", `未知工具: ${tool}`);
	if (!ROLE_TOOLS[role].includes(tool)) throw new LedgerError("role-forbidden", `角色 ${role} 无权使用工具 ${tool}`);
	if (taskId !== void 0 && EXECUTOR_TOOLS.includes(tool)) {
		const record = ledger.get(taskId);
		if (record === void 0) throw new LedgerError("task-not-found", `任务不存在: ${taskId}`);
		if (record.sessionId !== callerSessionId$1) throw new LedgerError("not-task-owner", `任务 ${taskId} 不属于会话 ${callerSessionId$1}`);
	}
}
/**
* exec.agent → sessionId。宿主 Agent.id 就是 sessionId（ReactLoopAgent 构造时
* this.id = id，api-session-controller 以 created.agent.id 作 sessionId）；
* 老样本里也有 agent.session.id 的读法，作兜底。
*/
function callerSessionId(exec) {
	const agent = exec?.agent;
	const id = typeof agent?.id === "string" && agent.id !== "" ? agent.id : typeof agent?.session?.id === "string" && agent.session.id !== "" ? agent.session.id : void 0;
	if (id === void 0) throw new LedgerError("caller-unresolved", "无法从 exec.agent 解析调用方会话 ID（宿主 Agent 身份字段缺失或类型不符）");
	return id;
}
/** 状态 → 中文词（render 用）。 */
const STATUS_LABEL$1 = {
	draft: "草稿",
	queued: "排队中",
	dispatched: "已派发",
	running: "执行中",
	"waiting-user": "等待用户",
	blocked: "受阻",
	paused: "已暂停",
	"review-pending": "待验收",
	completed: "已完成",
	cancelled: "已取消",
	failed: "失败"
};
/** 依赖条目的 JSON Schema（taskId 必填，version 仅审计）。 */
const TASK_REF_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		taskId: {
			type: "string",
			description: "依赖任务 ID（如 T-002）"
		},
		version: {
			type: "number",
			description: "依赖的任务书版本（可选，仅供审计）"
		}
	},
	required: ["taskId"]
};
/** string 数组参数。 */
function stringArray(description) {
	return {
		type: "array",
		items: { type: "string" },
		description
	};
}
/** 任务引用参数。 */
const TASK_ID_PARAM = {
	type: "string",
	description: "任务 ID（如 T-001）"
};
/** 八个工具的参数与输出 schema（形状照计划 Task B3 清单逐项）。 */
const TOOL_SPECS = {
	dispatch_task: {
		description: "创建任务并派发到独立执行会话。写清目标、验收条件与约束后派发；执行会话收到任务书全文，Router 不阻塞等待。",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				title: {
					type: "string",
					description: "任务标题（一行）"
				},
				goal: {
					type: "string",
					description: "目标：要达成什么、为什么"
				},
				acceptance: stringArray("验收条件：怎样才算做完"),
				constraints: stringArray("约束：范围、技术选型、禁做事项等"),
				role: {
					type: "string",
					enum: ["supervisor", "worker"],
					description: "指派角色：supervisor 可再拆分，worker 只执行"
				},
				templateId: {
					type: "string",
					description: "专业类型（worker 模板 ID）"
				},
				parentTaskId: {
					type: "string",
					description: "父任务 ID（主管再拆分时填写）"
				},
				dependsOn: {
					type: "array",
					items: TASK_REF_SCHEMA,
					description: "依赖任务：全部完成后本任务才派发"
				},
				materials: stringArray("输入材料：需求链接、文档路径等"),
				acceptancePolicy: {
					type: "string",
					enum: [
						"auto",
						"supervisor",
						"user"
					],
					description: "验收策略：auto 校验过即完成（默认）；supervisor 由你验收（control_task accept/reject）；user 由用户在验收卡确认"
				}
			},
			required: [
				"title",
				"goal",
				"acceptance",
				"role",
				"templateId"
			]
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				taskId: { type: "string" },
				docPath: { type: "string" },
				sessionId: { type: "string" }
			},
			required: ["taskId", "docPath"]
		},
		async run(core, sid, args) {
			const input = {
				title: String(args.title),
				goal: String(args.goal),
				acceptance: args.acceptance ?? [],
				constraints: args.constraints,
				role: args.role,
				templateId: String(args.templateId),
				parentTaskId: args.parentTaskId,
				dependsOn: args.dependsOn,
				materials: args.materials,
				acceptancePolicy: args.acceptancePolicy
			};
			return core.dispatchTask(sid, input);
		},
		render(args, value) {
			const v = value;
			return [
				`任务 ${v.taskId}「${String(args.title)}」已派发（${STATUS_LABEL$1.queued}→${STATUS_LABEL$1.dispatched}）。`,
				`任务书：${v.docPath}`,
				v.sessionId !== void 0 ? `执行会话：${v.sessionId}` : "执行会话：待分配"
			].join("\n");
		}
	},
	supplement_task: {
		description: "给已有任务补充约束：任务书升版并把新版本重投原执行会话。同一任务不要重新派发。",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				taskId: TASK_ID_PARAM,
				additions: stringArray("补充内容（每条一条约束或要求）")
			},
			required: ["taskId", "additions"]
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { docVersion: { type: "number" } },
			required: ["docVersion"]
		},
		async run(core, sid, args) {
			return core.supplementTask(sid, String(args.taskId), args.additions ?? []);
		},
		render(_args, value) {
			const v = value;
			return `任务书已升到 v${v.docVersion}，补充内容已重投执行会话；旧版本作废，完成提交须按 v${v.docVersion}。`;
		}
	},
	query_tasks: {
		description: "查询任务短卡：按状态或任务 ID 过滤。路由/主管随时可查全量。",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				status: {
					type: "array",
					items: { type: "string" },
					description: "按状态过滤（如 running、blocked）"
				},
				taskId: {
					type: "string",
					description: "只查这一个任务"
				}
			}
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				tasks: {
					type: "array",
					items: { type: "object" }
				},
				budgets: {
					type: "object",
					additionalProperties: true
				},
				breaker: {
					type: "object",
					additionalProperties: true
				}
			},
			required: ["tasks"]
		},
		async run(core, sid, args) {
			const filter = {};
			if (Array.isArray(args.status) && args.status.length > 0) filter.status = args.status;
			if (typeof args.taskId === "string" && args.taskId !== "") filter.taskId = args.taskId;
			return core.queryTasks(Object.keys(filter).length > 0 ? filter : void 0, sid);
		},
		render(_args, value) {
			const v = value;
			const cardsText = v.tasks.length === 0 ? "当前没有符合条件的任务。" : v.tasks.map((c) => [
				`${c.taskId}「${c.title}」${STATUS_LABEL$1[c.status]}`,
				`  角色 ${c.role}/${c.templateId}，任务书 v${c.docVersion}${c.sessionId !== void 0 ? `，会话 ${c.sessionId}` : ""}`,
				c.progress !== void 0 ? `  进度：${c.progress}` : null,
				c.waitingQuestions > 0 ? `  待用户回答 ${c.waitingQuestions} 个问题` : null
			].filter((line) => line !== null).join("\n")).join("\n");
			const notes = [];
			if (v.breaker?.frozen === true) notes.push(`⚠ 派发已冻结（${v.breaker.reason ?? "原因未记录"}）：停止一切派发与重试，向用户报告`);
			if (v.budgets !== void 0) {
				const b = v.budgets;
				notes.push(`派发预算：本轮已派 ${b.taskDispatchesThisTurn}/${b.taskLimitPerTurn} 个任务、${b.questionBatchesThisTurn}/${b.questionLimitPerTurn} 批提问；连续失败 ${b.consecutiveDispatchFailures}/${b.supervisorFailureLimit}${b.supervisorFrozen ? "（你的派发已冻结，出路 report_blocker）" : ""}${b.taskDispatchesThisTurn >= b.taskLimitPerTurn ? "；要再派任务请先 ask_user 确认" : ""}`);
			}
			return notes.length > 0 ? `${cardsText}\n${notes.join("\n")}` : cardsText;
		}
	},
	control_task: {
		description: "控制任务：pause（仅执行中可暂停）、resume（恢复执行）、cancel（取消并通知执行会话停止）、accept/reject（验收待验收任务：仅 acceptancePolicy=supervisor 且你是派发者/上级会话时可用；user 策略须由用户在验收卡确认，不得代验；reject 附 note 驳回意见，任务退回原执行者返工）。",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				taskId: TASK_ID_PARAM,
				action: {
					type: "string",
					enum: [
						"pause",
						"resume",
						"cancel",
						"accept",
						"reject"
					],
					description: "控制动作"
				},
				note: {
					type: "string",
					description: "驳回意见（action=reject 时给，会作为补充要求投递给原执行者）"
				}
			},
			required: ["taskId", "action"]
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { status: { type: "string" } },
			required: ["status"]
		},
		async run(core, sid, args) {
			return core.controlTask(sid, String(args.taskId), args.action, args.note);
		},
		render(_args, value) {
			const v = value;
			return `任务状态：${STATUS_LABEL$1[v.status]}（${v.status}）。`;
		}
	},
	search_history: {
		description: "检索历史记忆（项目/全局范围）：完成的任务结果、用户决定、已验证事实都在里面。命中按时间倒序，最多 20 条；命中为空就如实告知用户。",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				query: {
					type: "string",
					description: "检索词"
				},
				scope: {
					type: "string",
					enum: ["project", "global"],
					description: "检索范围"
				}
			},
			required: ["query", "scope"]
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				hits: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							memoryRef: { type: "string" },
							snippet: { type: "string" }
						}
					}
				},
				note: { type: "string" }
			},
			required: ["hits"]
		},
		async run(core, sid, args) {
			return core.searchHistory(sid, String(args.query), args.scope);
		},
		render(_args, value) {
			const v = value;
			if (v.hits.length === 0) return v.note !== void 0 ? `未命中（${v.note}）` : "未命中。";
			return v.hits.map((h) => `${h.memoryRef}: ${h.snippet}`).join("\n");
		}
	},
	report_progress: {
		description: "汇报一句话进度（写到任务进展，Router 的活动快照能看到）。长任务应当阶段性汇报。",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				taskId: TASK_ID_PARAM,
				progress: {
					type: "string",
					description: "一句话进度"
				}
			},
			required: ["taskId", "progress"]
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { ok: { type: "boolean" } },
			required: ["ok"]
		},
		async run(core, sid, args) {
			return core.reportProgress(sid, String(args.taskId), String(args.progress));
		},
		render(_args, value) {
			return value.ok ? "进度已记录。" : "进度记录失败。";
		}
	},
	complete_task: {
		description: "完成协议：申请交付任务。必须带当前任务书版本号（docVersion）；版本不符会被拒。是否完成由验收策略定——auto 即完成，否则进入待验收。",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				taskId: TASK_ID_PARAM,
				docVersion: {
					type: "number",
					description: "执行所依据的任务书版本（如 1）"
				},
				summary: {
					type: "string",
					description: "结果摘要"
				},
				deliverables: stringArray("交付物引用（文件路径等）"),
				acceptanceEvidence: {
					type: "string",
					description: "验收依据（测试、证据）"
				},
				leftovers: stringArray("遗留问题")
			},
			required: [
				"taskId",
				"docVersion",
				"summary"
			]
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				accepted: { type: "boolean" },
				status: { type: "string" },
				pendingFrom: { type: "string" }
			},
			required: ["accepted", "status"]
		},
		async run(core, sid, args) {
			const input = {
				docVersion: Number(args.docVersion),
				summary: String(args.summary),
				deliverables: args.deliverables,
				acceptanceEvidence: args.acceptanceEvidence,
				leftovers: args.leftovers
			};
			return core.completeTask(sid, String(args.taskId), input);
		},
		render(_args, value) {
			const v = value;
			if (v.accepted) return `任务完成（${STATUS_LABEL$1.completed}）。结果已入档，Router 已收到通知。`;
			const who = v.pendingFrom === "user" ? "用户" : "主管";
			return `提交已收到，任务进入${STATUS_LABEL$1["review-pending"]}——等待${who}验收，请勿重复提交；补充材料用 supplement_task 之外先等验收结论。`;
		}
	},
	report_blocker: {
		description: "报告阻塞：任务无法继续时用这个工具，不要用完成工具掩盖失败。写清缺什么、等什么。",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				taskId: TASK_ID_PARAM,
				reason: {
					type: "string",
					description: "阻塞原因：缺什么、等什么"
				}
			},
			required: ["taskId", "reason"]
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { status: { type: "string" } },
			required: ["status"]
		},
		async run(core, sid, args) {
			return core.reportBlocker(sid, String(args.taskId), String(args.reason));
		},
		render(_args, value) {
			return `任务已标记为${STATUS_LABEL$1.blocked}（${value.status}）；Router 会把阻塞转告用户。`;
		}
	},
	list_worker_types: {
		description: "列出当前全部 worker 类型（含停用与来源）：dispatch_task 的 templateId 必须取自这里的启用类型，不要凭记忆或猜测。",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {}
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { types: {
				type: "array",
				items: { type: "object" }
			} },
			required: ["types"]
		},
		async run(core, _sid, _args) {
			return { types: core.listWorkerTypes() };
		},
		render(_args, value) {
			const types = value.types;
			if (types.length === 0) return "当前没有任何 worker 类型，先告知调用方配置类型，不要派发。";
			return types.map((t) => `${t.templateId}=${t.name}（${t.role === "supervisor" ? "主管" : "worker"}，${t.enabled ? "启用" : "停用"}，来源 ${t.origin}）`).join("\n");
		}
	},
	create_worker_type: {
		description: "现场创建 worker 类型并立即注册其动态预设：创建成功即可按返回的 templateId 用 dispatch_task 派发。同名类型会被拒绝；presetRegistered=false 表示预设注册失败，此时派发该类型会被拒，须如实告知调用方。",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				name: {
					type: "string",
					minLength: 1,
					description: "类型名（如 文档写手；同名已存在会被拒）"
				},
				description: {
					type: "string",
					description: "一句话说明这个类型做什么"
				},
				role: {
					type: "string",
					enum: ["worker", "supervisor"],
					description: "角色（缺省 worker）"
				},
				systemPrompt: {
					type: "string",
					minLength: 1,
					description: "该类型的系统提示词（persona 整段替换）"
				},
				models: stringArray("允许模型列表（provider/model，有序；首个为该类型会话默认模型）"),
				skills: stringArray("初始技能名清单")
			},
			required: ["name", "systemPrompt"]
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				templateId: { type: "string" },
				presetRegistered: { type: "boolean" }
			},
			required: ["templateId", "presetRegistered"]
		},
		async run(core, sid, args) {
			const input = {
				name: String(args.name),
				description: typeof args.description === "string" ? args.description : void 0,
				role: args.role,
				systemPrompt: String(args.systemPrompt),
				models: args.models,
				skills: args.skills
			};
			return core.createWorkerType(sid, input);
		},
		render(args, value) {
			const v = value;
			const base = `worker 类型「${String(args.name)}」已创建（templateId=${v.templateId}）`;
			return v.presetRegistered ? `${base}，动态预设已注册：可立即用 dispatch_task 按该 templateId 派发。` : `${base}，但动态预设注册失败：当前按该 templateId 派发会被拒（template-unavailable），请如实告知调用方排查该类型的提示词/技能/模型配置。`;
		}
	}
};

//#endregion
//#region src/host/prompts/identity-cards.ts
/** 角色 → 中文身份标签（卡面用语；brief 的裁剪表：router=编排件、supervisor=编排+子代理、worker=执行件）。 */
const ROLE_LABEL = {
	router: "编排件：理解需求、拆解派发、追踪汇总",
	supervisor: "编排+执行件：自己承担部分工作，也可拆分子任务",
	worker: "执行件：把单个任务做完做对"
};
/** ask_user 是宿主原生工具（不在本插件白名单内），三身份都可用。 */
const ASK_USER_LINE = "- ask_user：向用户提问。只问真正必要的问题；问题直达用户界面浮窗，回答直接回到你的工具结果里。";
/**
* 宿主执行工具行（评审 F3）：统一超集给执行身份挂了 bash/fs/fs-search——清单里
* 必须逐一列名，否则「禁用提醒」会挡住正常执行。router（编排件）按设计不列：
* 它的产出是任务书与汇报，不是命令与文件（规格 §6 承接的误用风险）。
*/
const EXECUTION_TOOL_LINES = [
	"- bash：执行 shell 命令（跑测试、构建、查环境事实）。",
	"- fs：读写文件（读代码与材料、写交付物）。",
	"- fs-search：按文件名或内容搜索（找代码、找配置、找输入材料）。"
];
/** 技能挂载提示（评审 F6）：技能行按类型挂载，卡面如实声明「以会话实际在场为准」。 */
const SKILLS_NOTE = "- 若本类型配置了技能，会话里另有技能加载与技能调用工具，按会话实际挂载为准；没有挂载就如实用 report_blocker 说明。";
/** 本插件白名单内一个工具的卡面行（描述与注册定义同源）。 */
function toolLine(name$1) {
	return `- ${name$1}：${orchestrationToolDescription(name$1)}`;
}
/** 本身份可用工具清单（逐一列名；含 ask_user，主管加子代理，执行身份加宿主执行工具）。 */
function toolSection(role) {
	const lines = toolsForRole(role).map(toolLine);
	if (role === "supervisor") lines.push("- subagent：一次性子代理（进程内 spawn，空会话起步）：轻量收尾快的工作用它，提示词写自包含，结果随完成通知回来。");
	if (role !== "router") {
		lines.push(...EXECUTION_TOOL_LINES);
		lines.push(SKILLS_NOTE);
	}
	lines.push(ASK_USER_LINE);
	return lines.join("\n");
}
/** Router 身份卡（Router 会话创建成功后投递一次；requestId=identity-<sessionId> 幂等）。 */
function routerIdentityCard() {
	return `【身份卡】你是 Router：长期在线的任务编排器。用户的每一句话都说给你；真正的执行工作由独立的执行会话完成。

## 职责与边界

- 理解需求、澄清模糊处、把需求整理成任务（目标、验收条件、约束）、派发、追踪、汇总汇报。
- 你不亲自执行任务里的具体工作（不写代码、不跑命令）：这些属于执行会话。你的产出是清楚的任务书与准确的进度汇报。
- 可以连续接收多条需求：派发完成后不要等待执行结果，继续处理用户的下一条消息。执行会话的进展通过任务快照与通知到达你这里。
- 无需执行的事实问题直接回答，不建任务、不派发。答不准的先向用户澄清，再决定是否需要执行。
- 简单单步任务直接派 worker：一个执行会话一次做完，不要升级主管。多步、需要协调多方、或有依赖拆分的任务才派 supervisor；单点工作永远不要套两层。
- 派发前拿不准类型时先用 list_worker_types 查询，templateId 以它为准；没有合适的类型就先 create_worker_type 再派。
- 派发通道按轻重选（缓存优先模式下你会挂有 subagent 工具；没挂就以会话实际工具为准）：轻活（一次查询、单点小改、格式转换这类收尾快、不留持久产出的）直接用 subagent 开一次性子代理，提示词写自包含，不要为它建任务；重活或持久活（多轮交互、要向用户提问、要留文件或仓库改动的）才建任务派发（dispatch_task）。
- 任何关于任务当前状态的问题，用 query_tasks 查询，不要凭对话记忆断言。回答「进行得怎么样」前先查。
- 完成的任务结果与用户决定会自动进入记忆：回答「之前做过什么、定过什么」类问题前先 search_history，命中为空就如实说没有记录，不要编造。

## 本身份可用工具（逐一列名；以会话实际挂载为准，范围外的调用会被系统拒绝——不要尝试）

${toolSection("router")}
`;
}
/**
* 身份切换卡（分叉创建 worker 后投递的第一条消息的前段；主管分叉 worker 同路径
* 同格式）。三段：①身份与职责（=该类型的系统提示词全文）②本身份可用工具清单
* （逐一列名，按角色裁剪）③禁用提醒。任务书全文由投递方紧随其后拼接。
*/
function switchCard(type, role) {
	const prompt = type.systemPrompt.trim() !== "" ? type.systemPrompt : `你是「${type.name}」的执行者，完成分派给你的任务。`;
	return `【身份切换卡】你现在是「${type.name}」——${ROLE_LABEL[role]}。本卡权威最高：此前所有身份声明作废，以本卡为准。

## 身份与职责

${prompt}

## 本身份可用工具（逐一列名）

${toolSection(role)}

## 禁用提醒

- 上面清单之外的工具，即使你能在会话里看到，也一律不要调用：调用会被系统直接拒绝，只会浪费你一轮。需要范围外的工作，用 report_blocker 说明，由编排方处理。
`;
}
/**
* 最小面模式的投递头（规格 §2.4）：现行 persona 分置不变，投递仍带身份声明保持
* 协议一致，但不重申工具清单（工具面由该会话预设实际挂载决定）。
*/
function minimalSwitchHeader(type, role) {
	return `【身份切换卡】你现在是「${type.name}」（${ROLE_LABEL[role]}）。此前身份声明作废，以本卡为准；可用工具以本会话实际挂载为准。下面投递任务书。`;
}

//#endregion
//#region src/host/bridge/sessions.ts
/** 紧急暂停的取消原因（留痕 turn/end；auto-resume 对 hook cause 永不自动续跑）。 */
const EMERGENCY_STOP_REASON = "emergency-stop";
/**
* 宿主观察租约的释放（评审 F7）：宿主 observeSession 的租约经显式资源管理释放
* （`[Symbol.dispose]`），部分版本同时带 `.dispose` 方法——两个通道都调，缺哪个
* 跳哪个；undefined/空观察静默。minimal 五步路径用（不释放会泄漏 prepared
* session 缓存租约）。
*/
function releaseObservation(observation) {
	if (observation === null || observation === void 0) return;
	if (typeof observation !== "object") return;
	const record = observation;
	if (typeof record.dispose === "function") try {
		record.dispose();
	} catch {}
	const disposeSymbol = Symbol.dispose;
	if (disposeSymbol !== void 0 && typeof record[disposeSymbol] === "function") try {
		record[disposeSymbol]();
	} catch {}
}
/** 宿主 prompt 的 Remote 包装第一行就 throwIfAborted（r2 §2.1），必须有信号。 */
const PROMPT_TIMEOUT_MS = 12e4;
var SessionBridge = class {
	ledger;
	docsFor;
	workspaces;
	host;
	presets;
	forTemplate;
	types;
	interruptFace;
	logger;
	workerInstructions;
	mode;
	identityCards;
	onDelivered;
	signal;
	running = /* @__PURE__ */ new Map();
	statusListeners = [];
	constructor(deps) {
		this.ledger = deps.ledger;
		this.docsFor = deps.docsFor;
		this.workspaces = deps.workspaces;
		this.host = deps.host;
		this.presets = deps.presets;
		this.forTemplate = deps.forTemplate;
		this.types = deps.types;
		this.interruptFace = deps.interruptFace;
		this.logger = deps.logger;
		this.workerInstructions = deps.workerInstructions;
		const mode = deps.mode;
		this.mode = typeof mode === "function" ? mode : () => mode ?? "minimal-face";
		this.identityCards = deps.identityCards;
		this.onDelivered = deps.onDelivered;
		this.signal = deps.signal;
	}
	hostSignal() {
		return this.signal ?? AbortSignal.timeout(PROMPT_TIMEOUT_MS);
	}
	/**
	* infra 失败打标（v1.2 规格 §1）：宿主调用面（会话创建/登记/改名/投递）的
	* 失败在抛出前打 `failureClass: 'infra'` 标——分类器（guard/classify）读到标
	* 直接按 infra 计熔断，不靠错误形状推断（宿主可能抛任何形状的错误）。
	*/
	async tagged(stage, run) {
		try {
			return await run();
		} catch (error) {
			throw tagInfraFailure(error, stage);
		}
	}
	/** 任务的执行预设 id（router 角色不该被派发，防御性拒绝；类型在册走动态预设）。 */
	async presetFor(record) {
		if (record.role === "router") throw new LedgerError("role-forbidden", `任务 ${record.id} 指派了不可执行的角色 router`);
		if (record.role !== "supervisor" && record.role !== "worker") throw new LedgerError("role-forbidden", `任务 ${record.id} 指派了未知角色 ${String(record.role)}`);
		if (this.forTemplate !== void 0 && typeof record.templateId === "string" && record.templateId !== "") {
			const resolved = await this.forTemplate(record.templateId, record.role);
			if (resolved !== void 0 && resolved !== "") return resolved;
		}
		return this.presets[record.role];
	}
	/**
	* 默认模型钉定（v1.1 规格 §5 / r4 修正的有界探查）：新会话创建后、首轮投递
	* 前把该类型 models[0]（"provider/model"）设进去——宿主
	* sessionController.selectModel 正是界面 ModelSelect 的同一条通路。缺席、
	* 引用不合法、宿主调用失败都只告警，不挡派发（会话保持宿主默认路由）。
	*/
	async pinDefaultModel(sessionId, templateId) {
		if (this.host.selectModel === void 0 || this.types === void 0 || templateId === "") return;
		try {
			const ref = (await this.types.get(templateId))?.models[0];
			if (ref === void 0) return;
			const parsed = parseModelRef(ref);
			if (parsed === void 0) {
				this.logger?.warn(`类型 ${templateId} 的默认模型引用不合法（应为 "provider/model"）：${ref}，跳过钉定`);
				return;
			}
			await this.host.selectModel({
				sessionId,
				provider: parsed.provider,
				model: parsed.model
			});
		} catch (error) {
			this.logger?.warn(`会话 ${sessionId} 默认模型钉定失败（保持宿主默认路由）: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/** workspace 解析：projectId 回查 → 已有执行会话扫成员 → undefined（回退 cwd）。 */
	resolveWorkspace(record) {
		if (this.workspaces === void 0) return void 0;
		const byId = this.workspaces.get(record.projectId);
		if (byId !== void 0) return byId;
		if (record.sessionId !== void 0) {
			const bySession = this.workspaces.list().find((w) => w.sessionIds?.includes(record.sessionId));
			if (bySession !== void 0) return bySession;
		}
	}
	/** 投递卡片的类型身份（types 面缺席/查不到时回退 templateId 与空提示词）。 */
	async typeIdentity(templateId) {
		if (this.types !== void 0 && templateId !== "") {
			const record = await this.types.get(templateId);
			if (record !== void 0) return {
				name: record.name,
				systemPrompt: record.systemPrompt
			};
		}
		return {
			name: templateId === "" ? "执行者" : templateId,
			systemPrompt: ""
		};
	}
	/** 会话标题（v1.3 规格 §3.1：`类型名 · T-xxx 任务名`）。 */
	async sessionTitle(record) {
		return `${(await this.typeIdentity(record.templateId ?? "")).name} · ${record.id} ${record.title}`;
	}
	/** 分叉来源：显式 forkFrom（派发者会话）优先，其次父任务的执行会话。 */
	resolveForkSource(record, forkFrom) {
		if (forkFrom !== void 0 && forkFrom !== "") return forkFrom;
		if (record.parentId !== void 0) {
			const parent = this.ledger.get(record.parentId);
			if (parent?.sessionId !== void 0) return parent.sessionId;
		}
	}
	/**
	* cache-priority 创建段（规格 §3.1）：宿主 `session/fork`（继承来源历史/组合/
	* 模型，forkWorkspace 自动归组）→ 登记账本 → 改名；**不 selectModel**。
	* 宿主缺 fork face → infra 分类进熔断（Review Focus 4：不硬撞创建路径，
	* 正路是切 minimal-face 模式）。无分叉源 → undefined（回退创建路径）。
	*/
	async createByFork(record, title, source) {
		if (source === void 0) return void 0;
		if (this.host.fork === void 0) throw tagInfraFailure(/* @__PURE__ */ new Error("宿主缺 session/fork 面（sessionController.fork 缺席），cache-priority 模式无法分叉创建；请在设置切到 minimal-face 模式或升级宿主"), "分叉创建失败");
		const childId = (await this.tagged("分叉创建失败", () => this.host.fork({ sessionId: source }, this.hostSignal()))).sessionId;
		await this.tagged("会话登记失败", () => this.ledger.attachSession(record.id, childId));
		await this.tagged("会话改名失败", async () => {
			await this.host.rename?.(childId, title);
		});
		return childId;
	}
	/**
	* minimal-face 创建段（规格 §3.2，r10 §7 五步复刻）：observeSession →
	* boundary（最后 turn/end）→ buildForkSeed → resolvePreset+mount 组 setup →
	* agents.create → attachWorkspace → 登记 → 改名（selectModel 由 dispatchTask
	* 的回退外分支统一处理）。面不全 / 无分叉源 / 种子面不可用 → undefined（回退
	* 既有创建路径）；来源缺位、预设未注册、create 失败 → infra 分类（Review
	* Focus 4）。
	*/
	async createBySeed(record, title, source, workspace) {
		const host = this.host;
		if (source === void 0 || host.observeSession === void 0 || host.newSessionId === void 0 || host.agentsCreate === void 0 || host.resolvePreset === void 0 || host.mountPreset === void 0) return;
		const observation = await this.tagged("分叉源读取失败", () => host.observeSession(source));
		try {
			const events = observation?.events ?? [];
			let boundary;
			for (const event of events) if (event.type === "turn/end" && typeof event.seq === "number") boundary = event.seq;
			if (boundary === void 0) throw tagInfraFailure(/* @__PURE__ */ new Error(`分叉源会话 ${source} 没有已完成轮次（无 turn/end），无法构造分叉种子`), "分叉创建失败");
			const seed = host.buildForkSeed === void 0 ? void 0 : await host.buildForkSeed(events, boundary);
			if (!Array.isArray(seed)) {
				this.logger?.warn("buildForkSeed 面不可用（@deepseek-ai/dsh-session/fork 缺席？），本次分叉降级为普通创建");
				return;
			}
			const presetId = await this.presetFor(record);
			const resolved = await this.tagged("预设解析失败", async () => host.resolvePreset === void 0 ? { id: presetId } : host.resolvePreset(presetId));
			const childId = host.newSessionId();
			await this.tagged("分叉创建失败", async () => {
				await host.agentsCreate({
					sessionId: childId,
					seed,
					inheritedEventCount: boundary + 1,
					meta: {
						cwd: record.cwd,
						isSeeded: true,
						agentPreset: resolved.id
					},
					setup: host.mountPreset === void 0 ? void 0 : async (agentCtx) => {
						await host.mountPreset(agentCtx, resolved.id);
					}
				});
			});
			if (workspace !== void 0 && host.attachWorkspace !== void 0) try {
				await host.attachWorkspace(workspace.id, childId);
			} catch (error) {
				this.logger?.warn(`分叉子会话 ${childId} 挂 workspace ${workspace.id} 失败（不影响派发）: ${error instanceof Error ? error.message : String(error)}`);
			}
			await this.tagged("会话登记失败", () => this.ledger.attachSession(record.id, childId));
			await this.tagged("会话改名失败", async () => {
				await this.host.rename?.(childId, title);
			});
			return childId;
		} finally {
			observation?.dispose?.();
		}
	}
	/**
	* 首发投递正文（v1.3 规格 §2.3/§2.4）：cache-priority = 切换卡（①类型系统
	* 提示词 ②角色工具清单 ③禁用提醒）+ 任务书全文；minimal-face = 简化身份头 +
	* 现行格式（任务书 + 执行指引）。
	*/
	async firstDeliveryText(record, book) {
		const identity = await this.typeIdentity(record.templateId ?? "");
		const role = record.role === "supervisor" ? "supervisor" : "worker";
		if (this.mode() === "cache-priority") return `${switchCard(identity, role)}\n${book}`;
		return `${minimalSwitchHeader(identity, role)}\n${book}\n\n${this.workerInstructions()}`;
	}
	/**
	* Router 身份卡投递（v1.3 A2）：requestId=identity-<sessionId> 宿主侧幂等，
	* 已发标记（ui-state，跨重启）跳过；投递成功才打标，失败不打（下次重试时
	* 同 requestId 在宿主侧去重，不会双发）。
	*/
	async deliverRouterIdentityCard(sessionId) {
		if (this.identityCards?.has(sessionId)) return;
		await this.host.prompt({
			requestId: `identity-${sessionId}`,
			sessionId,
			mode: "queue",
			content: [{
				type: "text",
				text: routerIdentityCard()
			}]
		}, this.hostSignal());
		await this.identityCards?.mark(sessionId);
	}
	/**
	* 派发任务：无会话则建——cache-priority 优先宿主分叉（来源=派发者/父任务会话，
	* r10 §1 fork face；缺面=infra，无源=回退创建），minimal-face 五步复刻
	* （agents.create + buildForkSeed + worker 预设组合，r10 §2/§7；面不全或无源
	* 回退既有创建路径）；随后投任务书（requestId 幂等，cache 用 switch- 前缀），
	* 成功后走状态机到 dispatched。
	*/
	async dispatchTask(taskId, opts) {
		const record = this.ledger.get(taskId);
		if (record === void 0) throw new LedgerError("task-not-found", `任务不存在: ${taskId}`);
		const mode = this.mode();
		const book = await this.docsFor(record.cwd).readDoc(taskId, "task", record.docVersion);
		let sessionId = record.sessionId;
		if (sessionId === void 0) {
			const workspace = this.resolveWorkspace(record);
			const title = await this.sessionTitle(record);
			const forkSource = this.resolveForkSource(record, opts?.forkFrom);
			if (mode === "cache-priority") sessionId = await this.createByFork(record, title, forkSource);
			else sessionId = await this.createBySeed(record, title, forkSource, workspace);
			if (sessionId === void 0) {
				const agentPreset = await this.presetFor(record);
				const createOpts = workspace !== void 0 ? {
					workspaceId: workspace.id,
					agentPreset
				} : {
					cwd: record.cwd,
					agentPreset
				};
				const fresh = await this.tagged("会话创建失败", () => this.host.create(createOpts, this.hostSignal()));
				sessionId = fresh;
				await this.tagged("会话登记失败", () => this.ledger.attachSession(taskId, fresh));
				await this.tagged("会话改名失败", async () => {
					await this.host.rename?.(fresh, title);
				});
			}
			if (mode !== "cache-priority") await this.pinDefaultModel(sessionId, record.templateId ?? "");
		}
		const deliverySessionId = sessionId;
		const firstText = await this.firstDeliveryText(record, book);
		const requestId = mode === "cache-priority" ? `switch-${taskId}-v${record.docVersion}` : `dispatch-${taskId}-v${record.docVersion}`;
		await this.tagged("任务书投递失败", () => this.host.prompt({
			requestId,
			sessionId: deliverySessionId,
			mode: "queue",
			content: [{
				type: "text",
				text: firstText
			}]
		}, this.hostSignal()));
		if (record.status === "draft") await this.ledger.transition(taskId, "queued");
		if (record.status === "draft" || record.status === "queued") await this.ledger.transition(taskId, "dispatched");
		this.onDelivered?.(taskId, sessionId);
		return { sessionId };
	}
	/**
	* 补充重投：把当前版本任务书投给原执行会话（requestId 同规则、带新版本号）。
	* 任务还没有执行会话时不投递——它保持 queued 等依赖解锁后按新版本首发。
	*/
	async supplementTo(taskId) {
		const record = this.ledger.get(taskId);
		if (record === void 0) throw new LedgerError("task-not-found", `任务不存在: ${taskId}`);
		if (record.sessionId === void 0) return { sessionId: void 0 };
		const book = await this.docsFor(record.cwd).readDoc(taskId, "task", record.docVersion);
		const existingSessionId = record.sessionId;
		const supplementText = this.mode() === "cache-priority" ? book : `${book}\n\n${this.workerInstructions()}`;
		await this.tagged("任务书投递失败", () => this.host.prompt({
			requestId: `dispatch-${taskId}-v${record.docVersion}`,
			sessionId: existingSessionId,
			mode: "queue",
			content: [{
				type: "text",
				text: supplementText
			}]
		}, this.hostSignal()));
		this.onDelivered?.(taskId, existingSessionId);
		return { sessionId: existingSessionId };
	}
	/** 取消通知：steer 插到执行会话最近一步，尽快停下。无会话时静默跳过。 */
	async notifyCancel(taskId) {
		const record = this.ledger.get(taskId);
		if (record === void 0) throw new LedgerError("task-not-found", `任务不存在: ${taskId}`);
		if (record.sessionId === void 0) return;
		await this.notify(record.sessionId, `cancel-${taskId}`, `任务 ${record.id}「${record.title}」已被取消。请立即停止相关工作，不要继续提交；已产生的中间产物留在原地。`);
	}
	/** 通用投递通道（完成通知、暂停通知等；默认 steer 立即插到最近一步）。 */
	async notify(sessionId, requestId, text, mode = "steer") {
		await this.host.prompt({
			requestId,
			sessionId,
			mode,
			content: [{
				type: "text",
				text
			}]
		}, this.hostSignal());
	}
	/**
	* 紧急暂停的逐会话中断（v1.2 B4，r8 §5 推荐形态）：agents.get(id)?.cancel(
	* {kind:'hook',reason:'emergency-stop'},{keepInbox:true})——幂等、原因留痕
	* turn/end、排队消息保留（keepInbox）；空闲会话静默接受，冷会话天然 no-op。
	* 每会话二值结果聚合：单个失败不拖垮批量、如实上报 detail（Review Focus 5）；
	* 中断面未接线时全部如实 failed，不冒充受理。
	*/
	async interruptTaskSessions(sessionIds) {
		const outcomes = [];
		for (const sessionId of sessionIds) {
			if (this.interruptFace === void 0) {
				outcomes.push({
					sessionId,
					outcome: "failed",
					detail: "agents 中断面未接线（interruptFace 缺席），无法中断"
				});
				continue;
			}
			try {
				const agent = this.interruptFace.get(sessionId);
				if (agent === void 0) {
					outcomes.push({
						sessionId,
						outcome: "accepted",
						detail: "冷会话（无 live agent）：中断为 no-op"
					});
					continue;
				}
				if (typeof agent.cancel !== "function") {
					outcomes.push({
						sessionId,
						outcome: "failed",
						detail: "agents 中断面缺 cancel 方法（宿主版本不支持）"
					});
					continue;
				}
				await agent.cancel({
					kind: "hook",
					reason: EMERGENCY_STOP_REASON
				}, { keepInbox: true });
				outcomes.push({
					sessionId,
					outcome: "accepted"
				});
			} catch (error) {
				outcomes.push({
					sessionId,
					outcome: "failed",
					detail: error instanceof Error ? error.message : String(error)
				});
			}
		}
		return outcomes;
	}
	/** 订阅 api-session/status：记录运行标志（标签条 running 字段）并转发监听者。 */
	watchStatus() {
		this.host.onStatus((sessionId, isRunning) => {
			this.running.set(sessionId, isRunning);
			for (const listener of this.statusListeners) listener(sessionId, isRunning);
		});
	}
	/** 注册状态变化监听（压缩驱动等接线用）。 */
	onStatusChange(listener) {
		this.statusListeners.push(listener);
	}
	/** 会话是否在跑（未观察过 = false）。 */
	isRunning(sessionId) {
		return this.running.get(sessionId) ?? false;
	}
};

//#endregion
//#region src/host/bridge/questions.ts
/** 每任务提问预算的缺省上限（v1.1 规格 §3.6；Config questionBudget 可调）。 */
const DEFAULT_QUESTION_BUDGET = 2;
/** 超预算时的自动回答案（逐题同文；指明出路：任务书假设 + report_blocker）。 */
const QUESTION_BUDGET_EXHAUSTED_ANSWER = "提问预算已用尽：请基于任务书做合理假设继续执行，或调用 report_blocker 报告阻塞";
/** Router 会话每轮提问批次超限的自动回答案（v1.2 规格 §3；指明出路：请合并为一批重问）。 */
const ROUTER_QUESTION_BATCH_EXHAUSTED_ANSWER = "每轮最多 1 批提问：请合并为一批重问（把要确认的问题放进同一次提问）";
/** 问答桥：认领、park、应答、孤儿恢复、提问预算强制。 */
var AnswerRelay = class {
	parked = /* @__PURE__ */ new Map();
	ledger;
	newId;
	now;
	questionBudget;
	routerQuestions;
	logger;
	constructor(deps) {
		this.ledger = deps.ledger;
		this.newId = deps.newId;
		this.now = deps.now;
		this.questionBudget = typeof deps.questionBudget === "number" && deps.questionBudget >= 0 ? deps.questionBudget : DEFAULT_QUESTION_BUDGET;
		this.routerQuestions = deps.routerQuestions;
		this.logger = deps.logger;
	}
	/** 按会话 ID 找在册任务（worker/主管会话才有任务绑定）。 */
	async taskBySession(sessionId) {
		return (await this.ledger.listAll()).find((t) => t.sessionId === sessionId);
	}
	/**
	* user-questions/request 瀑布监听器：认领返回答案即否决链上其余人，
	* 放行调 next()。仅认领在册 worker/主管会话的问题；Router 会话一律放行。
	* 提问预算（v1.1 规格 §3.6）在认领层强制：该任务已认领批次达到上限时不再
	* park、不弹卡，逐题自动回「预算已用尽」的答案并 warn。
	*/
	async claimQuestion(request, next) {
		let sessionId;
		try {
			sessionId = callerSessionId(request);
		} catch {
			return next();
		}
		const taskRecord = await this.taskBySession(sessionId);
		if (taskRecord === void 0 || taskRecord.role === "router") {
			const routerQuestions = this.routerQuestions;
			if (routerQuestions !== void 0 && routerQuestions.isRouterSession(sessionId)) {
				if (!routerQuestions.tryConsumeQuestionBatch(sessionId).ok) {
					this.logger?.warn(`Router 会话 ${sessionId} 本轮提问批次已用尽，本次提问被自动回答（请合并为一批重问）`);
					return { answers: request.questions.map((question) => ({
						id: question.id,
						selected: [],
						custom: ROUTER_QUESTION_BATCH_EXHAUSTED_ANSWER
					})) };
				}
			}
			return next();
		}
		const claimed = await this.ledger.countTaskQuestions(taskRecord.id);
		if (claimed >= this.questionBudget) {
			this.logger?.warn(`任务 ${taskRecord.id} 的提问预算已用尽（已认领 ${claimed}/${this.questionBudget} 批），本次提问被拒并自动回答`);
			return { answers: request.questions.map((question) => ({
				id: question.id,
				selected: [],
				custom: QUESTION_BUDGET_EXHAUSTED_ANSWER
			})) };
		}
		return this.park(taskRecord, sessionId, request);
	}
	/** 认领：park deferred、落 open 记录、挂 pending，等 answerQuestion 或中止。 */
	async park(taskRecord, sessionId, request) {
		const questionId = this.newId();
		const receivedAt = this.now();
		const parked = {
			questionId,
			taskId: taskRecord.id,
			sessionId,
			questions: request.questions,
			receivedAt,
			resolve: () => {},
			reject: () => {}
		};
		const gate = new Promise((resolve, reject) => {
			parked.resolve = resolve;
			parked.reject = reject;
		});
		if (request.signal?.aborted) throw new LedgerError("question-cancelled", `问题已被中止: ${questionId}`);
		this.parked.set(questionId, parked);
		const summary = request.questions.length > 1 ? `${request.questions[0]?.question ?? ""} 等 ${request.questions.length} 个问题` : request.questions[0]?.question ?? "";
		const signal = request.signal;
		let aborted = false;
		const onAbort = () => {
			aborted = true;
			if (!this.parked.has(questionId)) return;
			this.parked.delete(questionId);
			parked.reject(new LedgerError("question-cancelled", `问题已被中止: ${questionId}`));
			this.ledger.settleQuestion(questionId, "expired", "问题被中止").catch(() => {});
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await this.ledger.addQuestion({
				id: questionId,
				taskId: taskRecord.id,
				question: summary,
				status: "open",
				createdAt: receivedAt
			});
		} catch (error) {
			signal?.removeEventListener("abort", onAbort);
			this.parked.delete(questionId);
			throw error;
		}
		if (aborted) {
			signal?.removeEventListener("abort", onAbort);
			this.parked.delete(questionId);
			await this.ledger.settleQuestion(questionId, "expired", "问题被中止").catch(() => {});
			parked.reject(new LedgerError("question-cancelled", `问题已被中止: ${questionId}`));
		}
		return gate;
	}
	/** 当前待答问题（Router 界面浮窗与 GET /router/state 的数据源）。 */
	pendingCards() {
		return [...this.parked.values()].sort((a, b) => a.receivedAt - b.receivedAt).map((parked) => {
			const taskRecord = parked.taskId !== void 0 ? this.ledger.get(parked.taskId) : void 0;
			return {
				questionId: parked.questionId,
				taskId: parked.taskId,
				taskTitle: taskRecord?.title,
				sessionId: parked.sessionId,
				sessionTitle: taskRecord !== void 0 ? `${taskRecord.id} ${taskRecord.title}` : void 0,
				questions: parked.questions,
				receivedAt: parked.receivedAt
			};
		});
	}
	/**
	* 用户应答：先落账本（失败则 worker 继续等待、用户可重试），后放行 deferred。
	* 已答（409 语义）与不存在（404 语义）分别抛 already-answered / question-not-found。
	*/
	async answerQuestion(questionId, answers) {
		const parked = this.parked.get(questionId);
		if (parked !== void 0) {
			await this.ledger.settleQuestion(questionId, "answered", JSON.stringify(answers));
			this.parked.delete(questionId);
			parked.resolve({ answers });
			return;
		}
		const record = await this.ledger.findQuestion(questionId);
		if (record === void 0 || record.status === "expired") throw new LedgerError("question-not-found", `问题不存在或已失效: ${questionId}`);
		throw new LedgerError("already-answered", `问题已应答，拒绝重复: ${questionId}`);
	}
	/**
	* 重启孤儿恢复：账本里遗留的 open 记录对应的 deferred 已随进程消失。
	* 仍在执行（状态机允许）的任务标 blocked；问题记录一律过期。
	*/
	async recoverOrphans() {
		const open$1 = await this.ledger.openQuestions();
		const recovered = [];
		for (const record of open$1) {
			const taskRecord = record.taskId !== void 0 ? this.ledger.get(record.taskId) : void 0;
			if (taskRecord !== void 0 && !isTerminal(taskRecord.status) && canTransition(taskRecord.status, "blocked")) await this.ledger.reportBlocker(taskRecord.id, `宿主重启，待答问题中断，任务标为受阻（原问题：${record.question}）`);
			await this.ledger.settleQuestion(record.id, "expired", "宿主重启，问题失效");
			recovered.push(record.id);
		}
		return recovered;
	}
};

//#endregion
//#region src/host/bridge/tabs.ts
/**
* 空壳任务判定（v1.1 规格 §3.7 / Review Focus 5）：cancelled/failed 且无会话。
* 清理只影响标签条与活动快照的**投影**，账本文件记录一律保留（归档可查）。
* record 缺省（标签行没有可判定的任务）→ 不是空壳，照常显示。
*/
function isHuskTask(record) {
	if (record === void 0) return false;
	return (record.status === "cancelled" || record.status === "failed") && record.sessionId === void 0;
}
var UiStateStore = class {
	persistence;
	now;
	routerRows = [];
	tabRows = [];
	/** 已投递身份卡的会话集（v1.3 A2；hasIdentityCard 同步读）。 */
	identityCardSessions = /* @__PURE__ */ new Set();
	loaded = false;
	constructor(persistence, now = Date.now) {
		this.persistence = persistence;
		this.now = now;
	}
	/** 装载（幂等；宿主装配时调用一次）。 */
	async load() {
		if (this.loaded) return;
		const file = await this.persistence.load();
		if (file !== null) {
			this.routerRows = structuredClone(file.routerSessions);
			this.tabRows = structuredClone(file.tabs);
			this.identityCardSessions = new Set(Array.isArray(file.identityCards) ? file.identityCards.filter((id) => typeof id === "string" && id !== "") : []);
		}
		this.loaded = true;
	}
	currentFile() {
		return {
			schemaVersion: 1,
			routerSessions: structuredClone(this.routerRows),
			tabs: structuredClone(this.tabRows),
			identityCards: [...this.identityCardSessions]
		};
	}
	/** 写通道：备份 → 变更 → save → 失败回滚。 */
	async commit(mutate) {
		await this.load();
		const backupSessions = structuredClone(this.routerRows);
		const backupTabs = structuredClone(this.tabRows);
		const backupCards = new Set(this.identityCardSessions);
		mutate();
		try {
			await this.persistence.save(this.currentFile());
		} catch (cause) {
			this.routerRows = backupSessions;
			this.tabRows = backupTabs;
			this.identityCardSessions = backupCards;
			throw new LedgerError("persistence-failed", `UI 状态保存失败，内存已回滚: ${String(cause)}`, { cause });
		}
	}
	/** 登记 Router 会话（同 sessionId 重复登记保持原位置，只更新名字）。 */
	async addRouterSession(sessionId, workspaceId, name$1) {
		await this.commit(() => {
			const existing = this.routerRows.find((row) => row.sessionId === sessionId);
			if (existing !== void 0) {
				existing.name = name$1;
				if (workspaceId !== void 0) existing.workspaceId = workspaceId;
				return;
			}
			this.routerRows.push({
				sessionId,
				workspaceId,
				name: name$1,
				createdAt: this.now()
			});
		});
	}
	/** RouterSessionInfo[]（登记序）。 */
	routerSessions() {
		return this.routerRows.map((row) => ({
			sessionId: row.sessionId,
			title: row.name
		}));
	}
	/** 该会话是否已投递过 Router 身份卡（同步读；未标记 = false）。 */
	hasIdentityCard(sessionId) {
		return this.identityCardSessions.has(sessionId);
	}
	/** 打「已投递身份卡」标记（幂等；重复标记保持单条，落盘持久化）。 */
	async markIdentityCardSent(sessionId) {
		if (this.identityCardSessions.has(sessionId)) return;
		await this.commit(() => {
			this.identityCardSessions.add(sessionId);
		});
	}
	/** 加标签（同 workspace+sessionId 已存在则更新 taskId，不新增）。 */
	async addTab(workspaceId, sessionId, taskId) {
		await this.commit(() => {
			const existing = this.tabRows.find((row) => row.workspaceId === workspaceId && row.sessionId === sessionId);
			if (existing !== void 0) {
				if (taskId !== void 0) existing.taskId = taskId;
				return;
			}
			this.tabRows.push({
				workspaceId,
				sessionId,
				taskId,
				addedAt: this.now()
			});
		});
	}
	/** 关标签：只移出标签条，返回是否真的移除了。 */
	async removeTab(workspaceId, sessionId) {
		let removed = false;
		await this.commit(() => {
			const before = this.tabRows.length;
			this.tabRows = this.tabRows.filter((row) => !(row.workspaceId === workspaceId && row.sessionId === sessionId));
			removed = this.tabRows.length < before;
		});
		return removed;
	}
	/** 某 workspace 的标签序（加入序）。 */
	tabs(workspaceId) {
		return this.tabRows.filter((row) => row.workspaceId === workspaceId);
	}
	/** 全量标签（state 路由缺省 workspaceId 时用；加入序）。 */
	allTabs() {
		return [...this.tabRows];
	}
};

//#endregion
//#region src/host/bridge/router-adoption.ts
/** 默认每轮预算：够慢，不够快。 */
const DEFAULT_BUDGET_PER_ROUND = 10;
/** 默认退避基数：一次失败后等这么久再试。 */
const DEFAULT_BASE_BACKOFF_MS = 2e3;
/** 默认退避上限：指数退避封顶（不热循环，也不无限拉长）。 */
const DEFAULT_MAX_BACKOFF_MS = 6e4;
/** 造一份空的护栏状态。 */
function createRouterAdoptionCache() {
	return {
		delivered: /* @__PURE__ */ new Set(),
		deferred: /* @__PURE__ */ new Map(),
		deferredHeap: [],
		rotation: 0,
		pending: void 0,
		counters: {
			rounds: 0,
			registered: 0,
			delivered: 0,
			verifyRejected: 0,
			staleSkipped: 0,
			retriesDropped: 0,
			errors: 0,
			maintenance: 0,
			budgetExhausted: 0
		}
	};
}
/** 收编诊断快照（entry 的 getHealth 用）。 */
function routerAdoptionDiagnostics(cache) {
	const reasons = {};
	let nextRetryAt;
	for (const record of cache.deferred.values()) {
		reasons[record.reason] = (reasons[record.reason] ?? 0) + 1;
		if (nextRetryAt === void 0 || record.nextAttemptAt < nextRetryAt) nextRetryAt = record.nextAttemptAt;
	}
	return {
		rounds: cache.counters.rounds,
		registered: cache.counters.registered,
		delivered: cache.counters.delivered,
		retryQueue: cache.deferred.size,
		deferred: cache.deferred.size,
		...nextRetryAt === void 0 ? {} : { nextRetryAt },
		deferredReasons: reasons,
		verifyRejected: cache.counters.verifyRejected,
		staleSkipped: cache.counters.staleSkipped,
		retriesDropped: cache.counters.retriesDropped,
		errors: cache.counters.errors,
		maintenance: cache.counters.maintenance,
		budgetExhausted: cache.counters.budgetExhausted,
		inflight: cache.pending !== void 0
	};
}
/** 当前仍是 router 判定（索引判定是唯一事实源）。 */
function isRouterNow(index, sessionId) {
	const lookup = index.verdictOf(sessionId);
	return lookup.status === "classified" && lookup.verdict === "router";
}
/**
* 扫描所有工作区的会话：只消费已验证索引中当前为 router 的候选；逐个定点
* 核验当前磁盘事实，未登记先登记，再幂等补发身份卡。unknown/damaged/large/old
* 会话只跳过自身，单个核验或副作用失败不拖垮同工作区邻居。
* @param deps - 宿主面与索引的包装。
* @param routerPresetId - Router 预设的 id（只用于诊断/日志口径；判定在索引内）。
* @param cache - 跨轮幂等标记、延期队列与单飞状态（缺省现造一份，只活这一轮）。
* @param options - 每轮预算与退避参数。
*/
async function scanAndAdoptRouterSessions(deps, routerPresetId, cache = createRouterAdoptionCache(), options = {}) {
	if (cache.pending !== void 0) {
		await cache.pending;
		return;
	}
	const run = adoptPass(deps, cache, options);
	cache.pending = run;
	try {
		await run;
	} finally {
		cache.pending = void 0;
	}
}
/** 一轮实际扫描。 */
async function adoptPass(deps, cache, options) {
	const budget = Math.max(0, options.budgetPerRound ?? DEFAULT_BUDGET_PER_ROUND);
	const baseBackoff = Math.max(0, options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS);
	const maxBackoff = Math.max(baseBackoff, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
	const now = (options.now ?? Date.now)();
	cache.counters.rounds += 1;
	let spent = 0;
	while (spent < budget) {
		const step = nextStep(deps, cache, now);
		if (step.kind === "none") break;
		if (step.kind === "maintenance") {
			cache.counters.maintenance += 1;
			spent += 1;
			continue;
		}
		try {
			await adoptCandidate(deps, cache, step.candidate, now, baseBackoff, maxBackoff);
		} catch (error) {
			cache.counters.errors += 1;
			retainOwnership(deps, cache, step.candidate, now, baseBackoff, maxBackoff);
			safeWarn(deps, `Router 会话收编异常（${step.candidate.sessionId}，退避后重试）: ${error instanceof Error ? error.message : String(error)}`);
		}
		spent += 1;
	}
	if (spent >= budget && hasMoreWork(deps, cache, now)) cache.counters.budgetExhausted += 1;
}
/**
* 取下一步工作（review I7 round 3：来源**明确交替**，轮转位跨轮保留）。
*
* - 轮转位 `cache.rotation` 决定本步**先试哪个来源**（0 = 到期重试，
*   1 = 新授予），每完成一步就翻转 —— 因此 budget=1 时也是交替的，新授予
*   不会被到期的失败积压长期饿死（round 2 的"到期优先"就是这个问题）。
* - 首选来源暂时没活时，回落到另一来源（不消耗预算：空检查是 O(1)）。
*/
function nextStep(deps, cache, now) {
	const preferDue = cache.rotation === 0;
	const take = (step) => {
		if (step.kind !== "none") cache.rotation = preferDue ? 1 : 0;
		return step;
	};
	if (preferDue) {
		const due$1 = popDueCandidate(deps, cache, now);
		if (due$1.kind !== "none") return take(due$1);
		const grant$1 = claimOneGrant(deps, cache);
		if (grant$1 !== void 0) return take({
			kind: "candidate",
			candidate: grant$1
		});
		return { kind: "none" };
	}
	const grant = claimOneGrant(deps, cache);
	if (grant !== void 0) return take({
		kind: "candidate",
		candidate: grant
	});
	const due = popDueCandidate(deps, cache, now);
	if (due.kind !== "none") return take(due);
	return { kind: "none" };
}
/** 是否还有（可能）可做的事：到期堆顶已到期，或未领取面非空。 */
function hasMoreWork(deps, cache, now) {
	const top = cache.deferredHeap[0];
	if (top !== void 0 && top.nextAttemptAt <= now) return true;
	return deps.index.unclaimedRouterGrantCount() > 0;
}
/**
* 取一条**到期**的延期候选（最小堆驱动）。
*
* **每次调用最多弹出一个堆条目**（review I7 round 3）：失效/墓碑条目返回
* `maintenance`（由调用方扣预算），不能内部无限 `continue` —— 否则一轮就能
* 清空整个失效积压（维护量 O(backlog) 且不占预算）。
*/
function popDueCandidate(deps, cache, now) {
	const top = cache.deferredHeap[0];
	if (top === void 0) return { kind: "none" };
	if (top.nextAttemptAt > now) return { kind: "none" };
	heapPop(cache);
	const record = cache.deferred.get(top.sessionId);
	if (record === void 0) return { kind: "maintenance" };
	if (record.nextAttemptAt !== top.nextAttemptAt) return { kind: "maintenance" };
	const generation = deps.index.routerGrantGeneration(top.sessionId);
	if (generation === void 0) {
		cache.deferred.delete(top.sessionId);
		return { kind: "maintenance" };
	}
	if (generation !== record.generation) {
		cache.deferred.delete(top.sessionId);
		return { kind: "maintenance" };
	}
	return {
		kind: "candidate",
		candidate: {
			sessionId: top.sessionId,
			generation: record.generation
		}
	};
}
/** 领取一条新授予（未领取面；O(1) 摊还，稳态未领取面为空 → 空过）。 */
function claimOneGrant(deps, cache) {
	const grant = deps.index.claimRouterGrants(1)[0];
	if (grant === void 0) return void 0;
	const record = cache.deferred.get(grant.sessionId);
	if (record !== void 0 && record.generation !== grant.generation) cache.deferred.delete(grant.sessionId);
	return {
		sessionId: grant.sessionId,
		generation: grant.generation
	};
}
/** 最小堆压入（按 nextAttemptAt）。 */
function heapPush(cache, entry) {
	const heap = cache.deferredHeap;
	heap.push(entry);
	let index = heap.length - 1;
	while (index > 0) {
		const parent = index - 1 >> 1;
		if (heap[parent].nextAttemptAt <= heap[index].nextAttemptAt) break;
		const tmp = heap[parent];
		heap[parent] = heap[index];
		heap[index] = tmp;
		index = parent;
	}
}
/** 最小堆弹出（堆顶）。 */
function heapPop(cache) {
	const heap = cache.deferredHeap;
	if (heap.length === 0) return void 0;
	const top = heap[0];
	const last = heap.pop();
	if (heap.length > 0) {
		heap[0] = last;
		let index = 0;
		for (;;) {
			const left = 2 * index + 1;
			const right = 2 * index + 2;
			let min = index;
			if (left < heap.length && heap[left].nextAttemptAt < heap[min].nextAttemptAt) min = left;
			if (right < heap.length && heap[right].nextAttemptAt < heap[min].nextAttemptAt) min = right;
			if (min === index) break;
			const tmp = heap[min];
			heap[min] = heap[index];
			heap[index] = tmp;
			index = min;
		}
	}
	return top;
}
/** 处理一个候选：定点核验 → 登记 → 复核 → 投递 → 记账。 */
async function adoptCandidate(deps, cache, candidate, now, baseBackoff, maxBackoff) {
	const sessionId = candidate.sessionId;
	try {
		if (!isRouterNow(deps.index, sessionId)) {
			cache.deferred.delete(sessionId);
			return;
		}
		let location = deps.index.locateMember(sessionId);
		if (location === void 0) {
			deps.index.refreshMembershipIfStale?.();
			location = deps.index.locateMember(sessionId);
			if (location === void 0) {
				deferCandidate(deps, cache, sessionId, candidate.generation, "not-member", now, baseBackoff, maxBackoff);
				return;
			}
		}
		if (location.archived) {
			deferCandidate(deps, cache, sessionId, candidate.generation, "archived", now, baseBackoff, maxBackoff);
			return;
		}
		let workspaceId = location.workspaceId;
		const fact = (await deps.index.verifyDiskFacts([sessionId])).get(sessionId);
		if (fact === void 0 || !fact.ok) {
			cache.counters.verifyRejected += 1;
			deferCandidate(deps, cache, sessionId, candidate.generation, `disk:${fact?.kind ?? "unknown"}`, now, baseBackoff, maxBackoff);
			return;
		}
		if (!isRouterNow(deps.index, sessionId)) {
			cache.counters.staleSkipped += 1;
			cache.deferred.delete(sessionId);
			return;
		}
		let authority = deps.index.verifyTargets([{
			workspaceId,
			sessionIds: [sessionId]
		}]).get(sessionId);
		if (authority === void 0 || !authority.member) {
			deps.index.refreshMembershipIfStale?.();
			const relocated = deps.index.locateMember(sessionId);
			if (relocated === void 0 || relocated.archived) {
				deferCandidate(deps, cache, sessionId, candidate.generation, "moved", now, baseBackoff, maxBackoff);
				return;
			}
			workspaceId = relocated.workspaceId;
			authority = deps.index.verifyTargets([{
				workspaceId,
				sessionIds: [sessionId]
			}]).get(sessionId);
			if (authority === void 0 || !authority.member || authority.archived) {
				deferCandidate(deps, cache, sessionId, candidate.generation, "moved", now, baseBackoff, maxBackoff);
				return;
			}
		}
		if (authority.archived) {
			deferCandidate(deps, cache, sessionId, candidate.generation, "archived", now, baseBackoff, maxBackoff);
			return;
		}
		const token = deps.index.authorityToken(sessionId);
		if (!deps.known(sessionId)) {
			await deps.register(sessionId, workspaceId);
			cache.counters.registered += 1;
			const factAfter = (await deps.index.verifyDiskFacts([sessionId])).get(sessionId);
			if (factAfter === void 0 || !factAfter.ok) {
				cache.counters.verifyRejected += 1;
				deferCandidate(deps, cache, sessionId, candidate.generation, `disk-after:${factAfter?.kind ?? "unknown"}`, now, baseBackoff, maxBackoff);
				return;
			}
			if (!isRouterNow(deps.index, sessionId)) {
				cache.counters.staleSkipped += 1;
				cache.deferred.delete(sessionId);
				return;
			}
			if (deps.index.authorityToken(sessionId) !== token) {
				cache.counters.staleSkipped += 1;
				deferCandidate(deps, cache, sessionId, candidate.generation, "lifecycle-changed", now, baseBackoff, maxBackoff);
				return;
			}
			const authorityAfter = deps.index.verifyTargets([{
				workspaceId,
				sessionIds: [sessionId]
			}]).get(sessionId);
			if (authorityAfter === void 0 || !authorityAfter.member || authorityAfter.archived) {
				deferCandidate(deps, cache, sessionId, candidate.generation, "moved", now, baseBackoff, maxBackoff);
				return;
			}
		}
		if (!cache.delivered.has(sessionId)) {
			await deps.deliver(sessionId);
			cache.delivered.add(sessionId);
			cache.counters.delivered += 1;
		}
		deps.index.ackRouterGrant(sessionId, candidate.generation);
		cache.deferred.delete(sessionId);
	} catch (error) {
		cache.counters.errors += 1;
		deferCandidate(deps, cache, sessionId, candidate.generation, "error", now, baseBackoff, maxBackoff);
		safeWarn(deps, `Router 会话收编失败（${sessionId}，退避后重试）: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/**
* 告警（**吞掉自己的异常**）：告警面抛错不得打断收编的恢复路径——否则
* 已领取的授予会失去所有者（round 3 N1）。
*/
function safeWarn(deps, message) {
	try {
		deps.logger?.warn(message);
	} catch {}
}
/**
* 保住一个已领取候选的**所有权**（round 3 N1）：正常路径是"延期"；连延期都
* 失败（索引面异常）时，把授予**交还**未领取面——下一轮重新领取，绝不留下
* "已领取但既不在 pending 也不在 deferred"的孤儿。
*/
function retainOwnership(deps, cache, candidate, now, baseBackoff, maxBackoff) {
	try {
		deferCandidate(deps, cache, candidate.sessionId, candidate.generation, "error", now, baseBackoff, maxBackoff);
		if (cache.deferred.has(candidate.sessionId)) return;
	} catch {}
	try {
		deps.index.releaseRouterGrant(candidate.sessionId, candidate.generation);
	} catch {}
}
/**
* 延期一个候选（**不丢**）：失败按指数退避改期（封顶），下一轮到期再试。
* 资格已撤销或已换代时直接移出——那不是丢弃：资格重新成立时索引会发新一代
* 授予（回到未领取面，由领取路径交付，不会被旧的延期项吞掉）。
*/
function deferCandidate(deps, cache, sessionId, generation, reason, now, baseBackoff, maxBackoff) {
	const current = deps.index.routerGrantGeneration(sessionId);
	if (current === void 0 || current !== generation) {
		cache.deferred.delete(sessionId);
		return;
	}
	const failures = (cache.deferred.get(sessionId)?.failures ?? 0) + 1;
	const nextAttemptAt = now + Math.min(maxBackoff, baseBackoff * 2 ** Math.min(failures - 1, 16));
	cache.deferred.delete(sessionId);
	cache.deferred.set(sessionId, {
		generation,
		failures,
		nextAttemptAt,
		reason
	});
	heapPush(cache, {
		sessionId,
		nextAttemptAt
	});
}

//#endregion
//#region src/host/session/header-io.ts
/** 当前已知的最高会话格式 generation（宿主 SESSION_FORMAT_VERSION=4）。 */
const MAX_KNOWN_SESSION_VERSION = 4;
/** 逐 chunk 读取的块大小（宿主 readFirstLine/readFirstZstdLine 同款 8KB）。 */
const CHUNK_BYTES = 8192;
const DEFAULT_MAX_COMPRESSED_BYTES = 262144;
const DEFAULT_MAX_DECOMPRESSED_BYTES = 65536;
const DEFAULT_DEADLINE_MS = 2e3;
/**
* 任意字符串编码为单个安全路径段（宿主 encodeSegment 移植）：安全字符原样、
* 其余按码单元 `~XXXX`（大写十六进制）转义，`.`/`..` 整段特判——中和路径
* 遍历、分隔符与 NUL 后才允许进文件系统。
*/
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < raw.length; i += 1) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
	}
	return out;
}
/** encodeSegment 的逆映射；只认合法转义（大写十六进制、四位、安全字符集）。 */
function decodeSegment(encoded) {
	let out = "";
	let i = 0;
	while (i < encoded.length) {
		const ch = encoded[i];
		if (ch === "~") {
			const hex = encoded.slice(i + 1, i + 5);
			if (!/^[0-9A-F]{4}$/.test(hex)) return void 0;
			out += String.fromCharCode(Number.parseInt(hex, 16));
			i += 5;
			continue;
		}
		if (!/^[A-Za-z0-9._-]$/.test(ch)) return void 0;
		out += ch;
		i += 1;
	}
	return out;
}
const GENERATION_NAME_RE = /^session\.(?:v([1-9][0-9]*)\.)?jsonl(\.zstd)?$/;
/**
* 规范 generation 文件名解析（宿主 parseGenerationLogFilename 语义）：v0 是
* 无版本后缀名 `session.jsonl[.zstd]`；v1+ 必须带 `vN`（无前导零）；其余名字
* （lock、临时名、`v0` 标记名、大写、尾缀）一律不识别。
*/
function parseGenerationFilename(name$1) {
	const match = GENERATION_NAME_RE.exec(name$1);
	if (match === null) return void 0;
	return {
		name: name$1,
		version: match[1] === void 0 ? 0 : Number(match[1]),
		zstd: match[2] !== void 0
	};
}
const V1PLUS_REQUIRED = [
	"type",
	"version",
	"id",
	"createdAt",
	"isSeeded",
	"delegationDepth"
];
const V1PLUS_OPTIONAL = [
	"cwd",
	"parentSession",
	"origin",
	"agentPreset"
];
const V0_REQUIRED = [
	"type",
	"version",
	"id",
	"createdAt",
	"delegationDepth"
];
const V0_OPTIONAL = [
	"cwd",
	"parentSession",
	"seedLength",
	"origin",
	"agentPreset"
];
function isCount(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
/**
* 首行头解析 + 校验。失败给人话错误（进诊断/告警）；成功只取分类所需的
* 最小事实。fail closed：未知字段、形状不符、id/version 不匹配一律拒绝。
*/
function parseHeaderLine(line, expect) {
	let value;
	try {
		value = JSON.parse(line);
	} catch (error) {
		return { error: `header line is not JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: "header line is not a JSON object" };
	const record = value;
	if (record["type"] !== "session") return { error: `header type is ${JSON.stringify(record["type"])}, expected 'session'` };
	if (record["version"] !== expect.version) return { error: `header version ${JSON.stringify(record["version"])} does not match generation ${expect.version}` };
	if (typeof record["id"] !== "string") return { error: "header id is not a string" };
	if (record["id"] !== expect.sessionId) return { error: `header id "${record["id"]}" does not match session "${expect.sessionId}"` };
	if (!isCount(record["createdAt"])) return { error: `header createdAt is not a non-negative safe integer: ${JSON.stringify(record["createdAt"])}` };
	if (!isCount(record["delegationDepth"])) return { error: `header delegationDepth is not a non-negative safe integer: ${JSON.stringify(record["delegationDepth"])}` };
	if (record["cwd"] !== void 0 && (typeof record["cwd"] !== "string" || !isAbsolute(record["cwd"]))) return { error: "header cwd must be an absolute path when present" };
	if (record["parentSession"] !== void 0 && typeof record["parentSession"] !== "string") return { error: "header parentSession must be a string when present" };
	if (record["origin"] !== void 0 && record["origin"] !== "subagent") return { error: `header origin must be "subagent" when present, got ${JSON.stringify(record["origin"])}` };
	if (record["agentPreset"] !== void 0 && typeof record["agentPreset"] !== "string") return { error: "header agentPreset must be a string when present" };
	let isSeeded;
	if (expect.version === 0) {
		if (Object.hasOwn(record, "isSeeded")) return { error: "format v0 header must not carry isSeeded" };
		if (record["seedLength"] !== void 0 && !isCount(record["seedLength"])) return { error: `header seedLength is not a non-negative safe integer: ${JSON.stringify(record["seedLength"])}` };
		isSeeded = Object.hasOwn(record, "seedLength");
	} else {
		if (Object.hasOwn(record, "seedLength")) return { error: `format v${expect.version} header must not carry seedLength` };
		if (typeof record["isSeeded"] !== "boolean") return { error: "header isSeeded must be a boolean" };
		isSeeded = record["isSeeded"];
	}
	const required = expect.version === 0 ? V0_REQUIRED : V1PLUS_REQUIRED;
	const optional = expect.version === 0 ? V0_OPTIONAL : V1PLUS_OPTIONAL;
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(record)) if (!allowed.has(key)) return { error: `format v${expect.version} header has unexpected field "${key}"` };
	for (const key of required) if (!Object.hasOwn(record, key)) return { error: `format v${expect.version} header lacks required field "${key}"` };
	return { facts: {
		version: expect.version,
		id: record["id"],
		createdAt: record["createdAt"],
		isSeeded,
		agentPreset: record["agentPreset"]
	} };
}
/** node:fs/promises + node:zlib 的默认实现；zstd 能力缺席时 zstd 为 undefined。 */
function defaultHeaderIoDeps() {
	return {
		readdir: async (dir) => readdir(dir, { withFileTypes: true }),
		lstat: (path) => lstat(path),
		open: (path) => open(path, "r"),
		zstd: typeof createZstdDecompress === "function" ? { createStream: () => createZstdDecompress() } : void 0
	};
}
/**
* I1 r3：有限在途 IO 槽位。每个底层操作发起前 tryAcquire——满额立即快速
* 降级（reason=limit，进冷却），**不在内存排队**；槽位在底层操作真正
* settle 时才释放（竞速超时返回不释放：迟到的 open/read/close 继续占槽，
* 直到其 promise 落定、迟到清理执行完毕）。
*/
var IoBudget = class {
	let;
	constructor(capacity) {
		this.capacity = capacity;
		this.let = capacity;
	}
	pendingReleases = /* @__PURE__ */ new Set();
	tryAcquire() {
		if (this.let <= 0) return false;
		this.let -= 1;
		return true;
	}
	release() {
		this.let = Math.min(this.capacity, this.let + 1);
	}
	/** 槽位在 op 真正 settle 时释放（与竞速结果无关）。 */
	attachRelease(op) {
		const releaseOnce = () => {
			this.release();
		};
		op.then(releaseOnce, releaseOnce);
		return op;
	}
	inFlight() {
		return this.capacity - this.let;
	}
	unused() {
		this.pendingReleases;
	}
};
/** 扫描默认封顶（brief v2：输入 256KiB / 解压 1MiB / 4096 行 / 单行 64KiB / 2s）。 */
const DEFAULT_SCAN_MAX_INPUT_BYTES = 262144;
const DEFAULT_SCAN_MAX_DECOMPRESSED_BYTES = 1048576;
const DEFAULT_SCAN_MAX_EVENT_LINES = 4096;
const DEFAULT_SCAN_MAX_LINE_BYTES = 65536;
const DEFAULT_SCAN_DEADLINE_MS = 2e3;
const ZSTD_MAGIC = 4247762216;
/**
* 从 `from` 起扫描下一个完整独立 zstd frame 的边界（宿主 scanZstdFrames 的
* 单 frame 移植 + 帧头声明解压尺寸提取）。数据不足以判定完整 frame 时返回
* 空（调用方继续读）；结构性坏输入（坏 magic/保留位）返回 error。
*/
function scanZstdFrame(buffer, from) {
	const start = from;
	let offset = from;
	if (buffer.length - offset < 4) return {};
	if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { error: `invalid frame magic at byte ${offset}` };
	offset += 4;
	if (offset === buffer.length) return {};
	const descriptor = buffer.readUInt8(offset);
	offset += 1;
	if ((descriptor & 24) !== 0) return { error: `reserved frame-header bit at byte ${offset - 1}` };
	const contentSizeFlag = descriptor >>> 6;
	const singleSegment = (descriptor & 32) !== 0;
	const checksum = (descriptor & 4) !== 0;
	const dictionaryFlag = descriptor & 3;
	const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
	const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
	const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
	if (buffer.length - offset < remainingHeaderBytes) return {};
	let contentSize;
	if (contentSizeBytes > 0) {
		const raw = buffer.readUIntLE(offset, contentSizeBytes);
		if (raw <= Number.MAX_SAFE_INTEGER) contentSize = raw;
	}
	offset += remainingHeaderBytes;
	for (;;) {
		if (buffer.length - offset < 3) return {};
		const blockHeader = buffer.readUIntLE(offset, 3);
		offset += 3;
		const lastBlock = (blockHeader & 1) !== 0;
		const blockType = blockHeader >>> 1 & 3;
		const blockSize = blockHeader >>> 3;
		if (blockType === 3) return { error: `reserved block type at byte ${offset - 3}` };
		const payloadBytes = blockType === 1 ? 1 : blockSize;
		if (buffer.length - offset < payloadBytes) return {};
		offset += payloadBytes;
		if (lastBlock) break;
	}
	if (checksum) {
		if (buffer.length - offset < 4) return {};
		offset += 4;
	}
	return { frame: {
		start,
		end: offset,
		...contentSize !== void 0 ? { contentSize } : {}
	} };
}
function isENOENT$1(error) {
	return error !== null && typeof error === "object" && error.code === "ENOENT";
}
/** 从 lstat/fstat 抽出稳定 EOF 核对所需的完整身份（字段缺席 → undefined）。 */
function identityOf(stat$1) {
	if (typeof stat$1.size !== "number" || typeof stat$1.mtimeMs !== "number" || typeof stat$1.ctimeMs !== "number" || typeof stat$1.dev !== "number" || typeof stat$1.ino !== "number") return;
	return {
		dev: stat$1.dev,
		ino: stat$1.ino,
		mtimeMs: stat$1.mtimeMs,
		ctimeMs: stat$1.ctimeMs,
		size: stat$1.size
	};
}
function identityEqual(a, b) {
	return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size;
}
/**
* 事件行最小良构信封（宿主 assertSessionEventEnvelope 同款白名单）：字段 ⊆
* {type,seq,time,data,surfaceOp,sourceEventSeqs,ignorable}；type 字符串、seq
* 从 0 连续的安全非负整数、time 安全整数、data 必在、ignorable 只许 true。
* 只对 agent-preset/selected 提取 data.agentPreset（必须字符串），其余事件
* 解析后即刻丢弃——不重放、不累积。
*/
function parseScanEventLine(line, expectedSeq) {
	let value;
	try {
		value = JSON.parse(line);
	} catch (error) {
		return { error: `line is not JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: "event line is not a JSON object" };
	const record = value;
	for (const key of Object.keys(record)) if (key !== "type" && key !== "seq" && key !== "time" && key !== "data" && key !== "surfaceOp" && key !== "sourceEventSeqs" && key !== "ignorable") return { error: `unexpected event envelope field "${key}"` };
	if (typeof record["type"] !== "string") return { error: "event type is not a string" };
	const seq = record["seq"];
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0)) return { error: `seq ${JSON.stringify(seq)} is not a non-negative safe integer` };
	if (seq !== expectedSeq) return { error: `seq ${seq} breaks continuity (expected ${expectedSeq})` };
	const time = record["time"];
	if (typeof time !== "number" || !Number.isSafeInteger(time)) return { error: "time is not a safe integer" };
	if (record["data"] === void 0) return { error: "data is missing" };
	if (record["ignorable"] !== void 0 && record["ignorable"] !== true) return { error: "ignorable must be true when present" };
	if (record["type"] === "agent-preset/selected") {
		const data = record["data"];
		if (typeof data !== "object" || data === null || Array.isArray(data)) return { error: "selected data is not an object" };
		const preset = data["agentPreset"];
		if (typeof preset !== "string") return { error: "selected agentPreset is not a string" };
		return { selected: preset };
	}
	return {};
}
/** 默认计时面：真实 setTimeout + unref（now 单位 = 毫秒纪元）。 */
const defaultIoTimer = { set(delayMs, fn) {
	const timer = setTimeout(fn, delayMs);
	timer.unref?.();
	return () => clearTimeout(timer);
} };
/** 有界首行头读取器。 */
var SessionHeaderReader = class {
	deps;
	/** I1 r3：在途底层 IO 槽位（可与索引共享同一预算）。 */
	ioBudget;
	constructor(deps = defaultHeaderIoDeps(), options = {}) {
		this.deps = deps;
		this.ioBudget = options.budget ?? new IoBudget(options.ioCapacity ?? 8);
	}
	/** 当前在途底层 IO 数（诊断/测试）。 */
	ioInFlight() {
		return this.ioBudget.inFlight();
	}
	/**
	* 取一个槽位租约（**不发 IO**）；额度满 → undefined（调用方快速降级）。
	*/
	acquireLease() {
		if (!this.ioBudget.tryAcquire()) return void 0;
		let released = false;
		return { release: () => {
			if (released) return;
			released = true;
			this.ioBudget.release();
		} };
	}
	/**
	* I1 r4：把一次**惰性**底层操作与「deadline timer + abort 信号」竞速。
	*
	* - **额度先于 IO**：`start` 是 thunk——先取到租约才调用它；额度满时直接
	*   返回 busy，底层操作**根本没有启动**（不再出现「先发 IO 再发现没额度」
	*   的无界 outstanding）。
	* - 挂起的 open/read/decoder 不再靠 IO 自己返回后的复查，而是到点立即
	*   返回；迟到结果交 `lateCleanup` 清理（如关句柄），迟到 rejection 已在
	*   守护分支吞掉（不产生 unhandledRejection）。
	* - 租约在底层操作**真正落定**时归还（迟到清理链落定后归还）；绝不先释放
	*   再抢新槽（满额时抢不到 = 泄句柄）。
	*/
	async raceOp(start, ctx, hooks = {}) {
		const policy = hooks.policy ?? "internal";
		const lease = policy === "internal" ? this.acquireLease() : hooks.lease;
		if (lease === void 0) return { kind: "busy" };
		const release = () => {
			if (policy === "external-owned") return;
			lease.release();
		};
		let io;
		try {
			io = start();
		} catch (error) {
			release();
			return {
				kind: "error",
				error
			};
		}
		let raceWon = false;
		io.then((value) => {
			if (raceWon) {
				if (hooks.lateCleanup !== void 0) Promise.resolve().then(() => hooks.lateCleanup(value)).then(release, release);
				else release();
				return;
			}
			if (policy === "external-transfer") return;
			release();
		}, () => release());
		let settled = false;
		let cancelTimer = () => void 0;
		let detachAbort;
		const expire = new Promise((resolve) => {
			cancelTimer = ctx.timer.set(Math.max(0, ctx.deadlineAt - ctx.now()), () => {
				if (!settled) resolve(ctx.signal?.aborted === true ? "aborted" : "limit");
			});
			const signal = ctx.signal;
			if (signal?.addEventListener !== void 0) {
				const listener = () => {
					if (!settled) resolve("aborted");
				};
				signal.addEventListener("abort", listener);
				detachAbort = () => signal.removeEventListener?.("abort", listener);
			}
		});
		const guarded = io.then((value) => ({
			kind: "value",
			value
		}), (error) => ({
			kind: "error",
			error
		}));
		const winner = await Promise.race([guarded, expire.then((reason) => ({
			kind: "expired",
			reason
		}))]);
		settled = true;
		cancelTimer();
		detachAbort?.();
		if (winner.kind === "expired") {
			raceWon = true;
			hooks.onExpire?.();
			return {
				kind: "expired",
				reason: winner.reason,
				op: io
			};
		}
		return winner;
	}
	expiredOutcome(reason, stage, stats) {
		if (reason === "aborted") return {
			ok: false,
			reason: "aborted",
			message: `header read aborted during ${stage}`,
			stats
		};
		return {
			ok: false,
			reason: "limit",
			message: `header read expired during ${stage}`,
			stats
		};
	}
	/** 额度满：快速降级（底层操作根本没启动）。 */
	busyOutcome(stage, stats) {
		return {
			ok: false,
			reason: "limit",
			message: `io budget exhausted during ${stage}`,
			stats
		};
	}
	/** 读一个会话目录的最高规范 generation 首行头（有界；绝不读正文）。 */
	async readSessionHeader(sessionDir, sessionId, options = {}) {
		const startAt = options.now !== void 0 ? options.now() : Date.now();
		const deadlineAt = options.deadlineAt ?? startAt + DEFAULT_DEADLINE_MS;
		const ctx = {
			maxCompressed: options.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES,
			maxDecompressed: options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES,
			deadlineAt,
			now: options.now ?? Date.now,
			signal: options.signal,
			timer: options.timer ?? defaultIoTimer
		};
		const zero = {
			bytesCompressed: 0,
			bytesDecompressed: 0
		};
		const listed = await this.raceOp(() => this.deps.readdir(sessionDir), ctx);
		if (listed.kind === "busy") return this.busyOutcome("directory listing", zero);
		if (listed.kind === "expired") return this.expiredOutcome(listed.reason, "directory listing", zero);
		if (listed.kind === "error") {
			if (isENOENT$1(listed.error)) return {
				ok: false,
				reason: "missing",
				message: `session directory not found: ${sessionId}`,
				stats: zero
			};
			return {
				ok: false,
				reason: "unreadable",
				message: `session directory unreadable: ${listed.error instanceof Error ? listed.error.message : String(listed.error)}`,
				stats: zero
			};
		}
		const names = listed.value;
		const generations = [];
		for (const entry of names) {
			const parsed = parseGenerationFilename(entry.name);
			if (parsed !== void 0) generations.push(parsed);
		}
		if (generations.length === 0) return {
			ok: false,
			reason: "missing",
			message: `no canonical generation log in session directory: ${sessionId}`,
			stats: {
				bytesCompressed: 0,
				bytesDecompressed: 0
			}
		};
		let highest = generations[0];
		let ambiguous = false;
		for (const candidate of generations.slice(1)) if (candidate.version > highest.version) {
			highest = candidate;
			ambiguous = false;
		} else if (candidate.version === highest.version) ambiguous = true;
		if (highest.version > MAX_KNOWN_SESSION_VERSION) return {
			ok: false,
			reason: "future-format",
			message: `session ${sessionId} highest generation v${highest.version} exceeds known v${MAX_KNOWN_SESSION_VERSION} (failing closed, no fallback)`,
			stats: {
				bytesCompressed: 0,
				bytesDecompressed: 0
			}
		};
		if (ambiguous) return {
			ok: false,
			reason: "ambiguous",
			message: `session ${sessionId} has generation v${highest.version} in both encodings`,
			stats: {
				bytesCompressed: 0,
				bytesDecompressed: 0
			}
		};
		const path = `${sessionDir}/${highest.name}`;
		const statted = await this.raceOp(() => this.deps.lstat(path), ctx);
		if (statted.kind === "busy") return this.busyOutcome("log stat", zero);
		if (statted.kind === "expired") return this.expiredOutcome(statted.reason, "log stat", zero);
		if (statted.kind === "error") {
			if (isENOENT$1(statted.error)) return {
				ok: false,
				reason: "missing",
				message: `generation log missing: ${sessionId}`,
				stats: zero
			};
			return {
				ok: false,
				reason: "unreadable",
				message: `generation log unstattable: ${statted.error instanceof Error ? statted.error.message : String(statted.error)}`,
				stats: zero
			};
		}
		if (!statted.value.isFile()) return {
			ok: false,
			reason: "corrupt",
			message: `generation log is not a regular file: ${sessionId}`,
			stats: zero
		};
		if (ctx.signal?.aborted === true) return {
			ok: false,
			reason: "aborted",
			message: "header read aborted",
			stats: zero
		};
		const handleLease = this.acquireLease();
		if (handleLease === void 0) return this.busyOutcome("log open", zero);
		const opened = await this.raceOp(() => this.deps.open(path), ctx, {
			lease: handleLease,
			policy: "external-transfer",
			lateCleanup: (late) => late.close().catch(() => void 0)
		});
		if (opened.kind === "busy") {
			handleLease.release();
			return this.busyOutcome("log open", zero);
		}
		if (opened.kind === "expired") return this.expiredOutcome(opened.reason, "log open", zero);
		if (opened.kind === "error") {
			handleLease.release();
			if (isENOENT$1(opened.error)) return {
				ok: false,
				reason: "missing",
				message: `generation log missing: ${sessionId}`,
				stats: zero
			};
			return {
				ok: false,
				reason: "unreadable",
				message: `generation log unopenable: ${opened.error instanceof Error ? opened.error.message : String(opened.error)}`,
				stats: zero
			};
		}
		const handle = opened.value;
		/** 迟到仍在途的读（超时后）：关闭必须等它落定（同一额度同一时刻 1 个操作）。 */
		let pending;
		try {
			const line = highest.zstd ? await this.readZstdFirstLine(handle, sessionId, ctx, handleLease) : await this.readPlainFirstLine(handle, sessionId, ctx, handleLease);
			if ("reason" in line) {
				pending = line.pending;
				return {
					ok: false,
					reason: line.reason,
					message: line.error,
					stats: line.stats
				};
			}
			const parsed = parseHeaderLine(line.line, {
				version: highest.version,
				sessionId
			});
			if ("error" in parsed) return {
				ok: false,
				reason: "corrupt",
				message: `session ${sessionId}: ${parsed.error}`,
				stats: line.stats
			};
			return {
				ok: true,
				header: parsed.facts,
				stats: line.stats
			};
		} finally {
			if (pending !== void 0) pending.then(() => {
				this.closeHandle(handle, ctx, handleLease);
			}, () => {
				this.closeHandle(handle, ctx, handleLease);
			});
			else await this.closeHandle(handle, ctx, handleLease);
		}
	}
	/**
	* 关闭句柄：沿用句柄保留的额度（不另取槽、不重复关闭）。**返回竞速结果**——
	* 调用方必须传播 expired/error（关闭失败不得被当成成功）。
	*/
	async closeHandle(handle, ctx, lease) {
		return this.raceOp(() => handle.close(), ctx, {
			lease,
			policy: "external"
		});
	}
	/**
	* 有界流式扫描**当前 v4** 小日志到**稳定 EOF**：跟踪 agent-preset/selected
	* （含首 turn/start 之后的——首 turn 不是安全封闭边界，宿主 select() 竞态
	* 已证伪），EOF 时的最后值即当前组合快照（header.agentPreset ?? null 起）。
	*
	* 稳定性 = 路径 lstat 前后身份一致 ∧ 打开句柄 fstat 前后一致 ∧ 句柄身份与
	* 路径身份相等 ∧ 读满文件 size；任一不满足 → unstable（瞬态，调用方改期
	* 重试）。封顶：输入/解压/行数/单行/时限，越界 → cap（终态，日志太大）。
	* torn（尾行无换行/尾帧不完整）、坏 JSON、seq 缺口、信封违规、坏 selected
	* 载荷、legacy（v0-v3）/future/编码歧义 → 关死（终态）。绝不整日志缓冲、
	* 绝不调用宿主整日志服务。
	*/
	async scanSessionLog(sessionDir, sessionId, options = {}) {
		const startAt = options.now !== void 0 ? options.now() : Date.now();
		const maxLines = options.maxEventLines ?? DEFAULT_SCAN_MAX_EVENT_LINES;
		const maxLine = options.maxLineBytes ?? DEFAULT_SCAN_MAX_LINE_BYTES;
		const ctx = {
			maxCompressed: options.maxInputBytes ?? DEFAULT_SCAN_MAX_INPUT_BYTES,
			maxDecompressed: options.maxDecompressedBytes ?? DEFAULT_SCAN_MAX_DECOMPRESSED_BYTES,
			deadlineAt: options.deadlineAt ?? startAt + DEFAULT_SCAN_DEADLINE_MS,
			now: options.now ?? Date.now,
			signal: options.signal,
			timer: options.timer ?? defaultIoTimer
		};
		const stats = {
			bytesCompressed: 0,
			bytesDecompressed: 0,
			lines: 0
		};
		const fail = (reason, message) => ({
			ok: false,
			reason,
			message,
			stats: { ...stats }
		});
		const listed = await this.raceOp(() => this.deps.readdir(sessionDir), ctx);
		if (listed.kind === "busy") return fail("limit", "io budget exhausted during directory listing");
		if (listed.kind === "expired") return fail(listed.reason, "scan expired during directory listing");
		if (listed.kind === "error") {
			if (isENOENT$1(listed.error)) return fail("missing", `session directory not found: ${sessionId}`);
			return fail("unreadable", `session directory unreadable: ${listed.error instanceof Error ? listed.error.message : String(listed.error)}`);
		}
		const generations = [];
		for (const entry of listed.value) {
			const parsed = parseGenerationFilename(entry.name);
			if (parsed !== void 0) generations.push(parsed);
		}
		if (generations.length === 0) return fail("missing", `no canonical generation log in session directory: ${sessionId}`);
		let highest = generations[0];
		let ambiguous = false;
		for (const candidate of generations.slice(1)) if (candidate.version > highest.version) {
			highest = candidate;
			ambiguous = false;
		} else if (candidate.version === highest.version) ambiguous = true;
		if (highest.version > MAX_KNOWN_SESSION_VERSION) return fail("future-format", `session ${sessionId} highest generation v${highest.version} exceeds known v${MAX_KNOWN_SESSION_VERSION} (failing closed, no fallback)`);
		if (highest.version < MAX_KNOWN_SESSION_VERSION) return fail("unsupported", `session ${sessionId}: legacy format v${highest.version} not scannable (stable-EOF scan covers current v${MAX_KNOWN_SESSION_VERSION} only)`);
		if (ambiguous) return fail("ambiguous", `session ${sessionId} has generation v${highest.version} in both encodings`);
		const path = `${sessionDir}/${highest.name}`;
		const preStat = await this.raceOp(() => this.deps.lstat(path), ctx);
		if (preStat.kind === "busy") return fail("limit", "io budget exhausted during log stat");
		if (preStat.kind === "expired") return fail(preStat.reason, "scan expired during log stat");
		if (preStat.kind === "error") {
			if (isENOENT$1(preStat.error)) return fail("missing", `generation log missing: ${sessionId}`);
			return fail("unreadable", `generation log unstattable: ${preStat.error instanceof Error ? preStat.error.message : String(preStat.error)}`);
		}
		if (!preStat.value.isFile()) return fail("corrupt", `generation log is not a regular file: ${sessionId}`);
		const identityA = identityOf(preStat.value);
		if (identityA === void 0) return fail("unstable", `session ${sessionId}: path identity facts unavailable (cannot prove stable EOF)`);
		const handleLease = this.acquireLease();
		if (handleLease === void 0) return fail("limit", "io budget exhausted during log open");
		const opened = await this.raceOp(() => this.deps.open(path), ctx, {
			lease: handleLease,
			policy: "external-transfer",
			lateCleanup: (late) => late.close().catch(() => void 0)
		});
		if (opened.kind === "busy") {
			handleLease.release();
			return fail("limit", "io budget exhausted during log open");
		}
		if (opened.kind === "expired") return fail(opened.reason, "scan expired during log open");
		if (opened.kind === "error") {
			handleLease.release();
			if (isENOENT$1(opened.error)) return fail("missing", `generation log missing: ${sessionId}`);
			return fail("unreadable", `generation log unopenable: ${opened.error instanceof Error ? opened.error.message : String(opened.error)}`);
		}
		const handle = opened.value;
		let pending;
		let handleClosed = false;
		/**
		* 同步关闭（成功路径）：**传播** close 的 expired/error——关闭失败不得被
		* 当成扫描成功（否则既报告了 ok，又留着未关的句柄）。
		*/
		const closeNow = async () => {
			if (handleClosed) return {
				kind: "value",
				value: void 0
			};
			handleClosed = true;
			return this.closeHandle(handle, ctx, handleLease);
		};
		/**
		* 后台清理链：迟到操作（read/fstat）落定后**异步**关闭一次（沿用同一租约）
		* ——调用者按 deadline/abort 及时返回，不被永不落定的底层操作拖住；
		* 迟到操作仍在途时不并发占用同一额度（同一时刻至多 1 个在途操作）。
		*/
		const closeInBackground = (pendingOp) => {
			if (handleClosed) return;
			handleClosed = true;
			(async () => {
				if (pendingOp !== void 0) await pendingOp.then(() => void 0, () => void 0);
				await this.closeHandle(handle, ctx, handleLease);
			})().catch(() => void 0);
		};
		try {
			if (handle.stat === void 0) return fail("unstable", `session ${sessionId}: opened-handle stat unavailable (cannot prove stable EOF)`);
			const handleStat = await this.raceOp(() => handle.stat(), ctx, {
				lease: handleLease,
				policy: "external-owned"
			});
			if (handleStat.kind === "busy") return fail("limit", "io budget exhausted during handle stat");
			if (handleStat.kind === "expired") {
				pending = handleStat.op;
				return fail(handleStat.reason, "scan expired during handle stat");
			}
			if (handleStat.kind === "error") return fail("unreadable", `session ${sessionId}: handle stat failed: ${handleStat.error instanceof Error ? handleStat.error.message : String(handleStat.error)}`);
			if (!identityEqual(handleStat.value, identityA)) return fail("unstable", `session ${sessionId}: opened file identity differs from path identity (replaced between stat and open)`);
			let partialParts = [];
			let partialLen = 0;
			let sawHeader = false;
			let headerFacts;
			let finalPreset = null;
			let nextSeq = 0;
			const handleLineBytes = (lineBytes) => {
				if (!sawHeader) {
					const parsed$1 = parseHeaderLine(lineBytes.toString("utf8"), {
						version: highest.version,
						sessionId
					});
					if ("error" in parsed$1) return {
						reason: "corrupt",
						message: `session ${sessionId}: ${parsed$1.error}`
					};
					sawHeader = true;
					headerFacts = parsed$1.facts;
					finalPreset = parsed$1.facts.agentPreset ?? null;
					return;
				}
				if (stats.lines >= maxLines) return {
					reason: "cap",
					message: `log exceeds ${maxLines} complete event lines`
				};
				const parsed = parseScanEventLine(lineBytes.toString("utf8"), nextSeq);
				if ("error" in parsed) return {
					reason: "corrupt",
					message: `session ${sessionId}: event at seq ${nextSeq}: ${parsed.error}`
				};
				if (parsed.selected !== void 0) finalPreset = parsed.selected;
				nextSeq += 1;
				stats.lines += 1;
			};
			const feedBytes = (slice) => {
				let start = 0;
				for (;;) {
					const newline = slice.indexOf(10, start);
					if (newline === -1) {
						const tail = slice.subarray(start);
						partialLen += tail.length;
						if (partialLen > maxLine) return {
							reason: "cap",
							message: `log line exceeds ${maxLine} bytes`
						};
						partialParts.push(Buffer.from(tail));
						return;
					}
					if (partialLen + (newline - start) > maxLine) return {
						reason: "cap",
						message: `log line exceeds ${maxLine} bytes`
					};
					const lineBytes = partialParts.length === 0 ? slice.subarray(start, newline) : Buffer.concat([...partialParts, slice.subarray(start, newline)]);
					partialParts = [];
					partialLen = 0;
					const err = handleLineBytes(lineBytes);
					if (err !== void 0) return err;
					start = newline + 1;
					if (start === slice.length) return void 0;
				}
			};
			const tornTail = () => partialLen > 0 ? "torn trailing bytes without final newline" : void 0;
			const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
			let readTotal = 0;
			const readOnce = async (readLen) => this.raceOp(() => handle.read(chunk, 0, readLen, null), ctx, {
				lease: handleLease,
				policy: "external-owned"
			});
			const eofBody = () => {
				const torn = tornTail();
				if (torn !== void 0) return fail("corrupt", `session ${sessionId}: ${torn}`);
			};
			if (!highest.zstd) {
				for (;;) {
					const gate = this.chunkGate(ctx);
					if (gate !== void 0) return fail(gate.reason, gate.error);
					const remaining = Math.min(ctx.maxCompressed - readTotal, ctx.maxDecompressed - readTotal);
					const read = await readOnce(remaining > 0 ? Math.min(chunk.length, remaining) : 1);
					if (read.kind === "busy") return fail("limit", "io budget exhausted during read");
					if (read.kind === "expired") {
						pending = read.op;
						return fail(read.reason, "scan expired during read");
					}
					if (read.kind === "error") return fail("unreadable", `session ${sessionId}: log read failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`);
					const { bytesRead } = read.value;
					const after = this.chunkGate(ctx);
					if (after !== void 0) {
						stats.bytesCompressed = readTotal + bytesRead;
						stats.bytesDecompressed = readTotal + bytesRead;
						return fail(after.reason, after.error);
					}
					if (bytesRead === 0) break;
					if (remaining <= 0) {
						stats.bytesCompressed = readTotal + bytesRead;
						stats.bytesDecompressed = readTotal + bytesRead;
						return fail("cap", `log exceeds small-log scan limit (input ${ctx.maxCompressed} / output ${ctx.maxDecompressed} bytes)`);
					}
					readTotal += bytesRead;
					stats.bytesCompressed = readTotal;
					stats.bytesDecompressed = readTotal;
					const fed = feedBytes(chunk.subarray(0, bytesRead));
					if (fed !== void 0) return fail(fed.reason, fed.message);
				}
				const torn = eofBody();
				if (torn !== void 0) return torn;
			} else {
				if (this.deps.zstd === void 0) return fail("unsupported", `session ${sessionId}: zstd log but node:zlib zstd unavailable`);
				let content = Buffer.alloc(0);
				let eof = false;
				for (;;) {
					for (;;) {
						const gate = this.chunkGate(ctx);
						if (gate !== void 0) return fail(gate.reason, gate.error);
						const scan = scanZstdFrame(content, 0);
						if (scan.error !== void 0) return fail("corrupt", `session ${sessionId}: corrupt Zstandard log: ${scan.error}`);
						if (scan.frame === void 0) break;
						if (scan.frame.contentSize !== void 0 && scan.frame.contentSize > ctx.maxDecompressed - stats.bytesDecompressed) return fail("cap", `session ${sessionId}: frame declares ${scan.frame.contentSize} decompressed bytes beyond remaining budget (small-log scan limit)`);
						const already = stats.bytesDecompressed;
						const decoded = await this.decodeFrameChunked(content.subarray(0, scan.frame.end), sessionId, ctx, handleLease, already, (piece) => feedBytes(piece));
						if ("reason" in decoded) {
							stats.bytesDecompressed += decoded.total;
							if (decoded.pending !== void 0) pending = decoded.pending;
							return fail(decoded.reason, decoded.message);
						}
						stats.bytesDecompressed += decoded.total;
						content = content.subarray(scan.frame.end);
					}
					if (eof) break;
					const remaining = ctx.maxCompressed - readTotal;
					if (remaining <= 0) {
						const read$1 = await readOnce(1);
						if (read$1.kind === "busy") return fail("limit", "io budget exhausted during read");
						if (read$1.kind === "expired") {
							pending = read$1.op;
							return fail(read$1.reason, "scan expired during read");
						}
						if (read$1.kind === "error") return fail("unreadable", `session ${sessionId}: log read failed: ${read$1.error instanceof Error ? read$1.error.message : String(read$1.error)}`);
						if (read$1.value.bytesRead > 0) {
							stats.bytesCompressed = readTotal + read$1.value.bytesRead;
							return fail("cap", `log input exceeds ${ctx.maxCompressed} bytes (small-log scan limit)`);
						}
						eof = true;
						continue;
					}
					const read = await readOnce(Math.min(chunk.length, remaining));
					if (read.kind === "busy") return fail("limit", "io budget exhausted during read");
					if (read.kind === "expired") {
						pending = read.op;
						return fail(read.reason, "scan expired during read");
					}
					if (read.kind === "error") return fail("unreadable", `session ${sessionId}: log read failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`);
					const { bytesRead } = read.value;
					const after = this.chunkGate(ctx);
					if (after !== void 0) {
						stats.bytesCompressed = readTotal + bytesRead;
						return fail(after.reason, after.error);
					}
					if (bytesRead === 0) {
						eof = true;
						continue;
					}
					readTotal += bytesRead;
					stats.bytesCompressed = readTotal;
					content = content.length === 0 ? Buffer.from(chunk.subarray(0, bytesRead)) : Buffer.concat([content, chunk.subarray(0, bytesRead)]);
				}
				if (content.length > 0) return fail("corrupt", `session ${sessionId}: torn trailing frame bytes without a complete frame`);
				const torn = eofBody();
				if (torn !== void 0) return torn;
			}
			if (readTotal !== identityA.size) return fail("unstable", `session ${sessionId}: read ${readTotal} bytes but file size is ${identityA.size} (changed during scan)`);
			const postHandleStat = await this.raceOp(() => handle.stat(), ctx, {
				lease: handleLease,
				policy: "external-owned"
			});
			if (postHandleStat.kind === "busy") return fail("limit", "io budget exhausted during post-scan handle stat");
			if (postHandleStat.kind === "expired") {
				pending = postHandleStat.op;
				return fail(postHandleStat.reason, "scan expired during post-scan handle stat");
			}
			if (postHandleStat.kind === "error") return fail("unreadable", `session ${sessionId}: post-scan handle stat failed: ${postHandleStat.error instanceof Error ? postHandleStat.error.message : String(postHandleStat.error)}`);
			if (!identityEqual(postHandleStat.value, identityA)) return fail("unstable", `session ${sessionId}: file changed during scan (handle identity moved)`);
			const closed = await closeNow();
			if (closed.kind === "expired") return fail(closed.reason, "scan expired during close");
			if (closed.kind === "error") return fail("unreadable", `session ${sessionId}: close failed: ${closed.error instanceof Error ? closed.error.message : String(closed.error)}`);
			const postStat = await this.raceOp(() => this.deps.lstat(path), ctx);
			if (postStat.kind === "busy") return fail("limit", "io budget exhausted during post-scan stat");
			if (postStat.kind === "expired") return fail(postStat.reason, "scan expired during post-scan stat");
			if (postStat.kind === "error") {
				if (isENOENT$1(postStat.error)) return fail("missing", `generation log missing after scan: ${sessionId}`);
				return fail("unreadable", `generation log unstattable after scan: ${postStat.error instanceof Error ? postStat.error.message : String(postStat.error)}`);
			}
			if (!identityEqual(identityOf(postStat.value) ?? {
				dev: NaN,
				ino: NaN,
				mtimeMs: NaN,
				ctimeMs: NaN,
				size: NaN
			}, identityA)) return fail("unstable", `session ${sessionId}: path identity moved during scan`);
			const finalGate = this.chunkGate(ctx);
			if (finalGate !== void 0) return fail(finalGate.reason, finalGate.error);
			return {
				ok: true,
				header: headerFacts,
				finalPreset,
				file: highest,
				identity: identityA,
				stats: { ...stats }
			};
		} finally {
			if (pending !== void 0) closeInBackground(pending);
			else await closeNow();
		}
	}
	/** 流式解码一个完整 frame，逐 chunk 喂调用方（不缓冲整帧输出）；越界即毁流。 */
	async decodeFrameChunked(frame, sessionId, ctx, lease, alreadyDecompressed, onChunk) {
		let stream;
		let produced = 0;
		const raced = await this.raceOp(() => {
			stream = this.deps.zstd.createStream();
			return new Promise((resolve) => {
				let total = 0;
				let settled = false;
				const finish = (result) => {
					if (settled) return;
					settled = true;
					resolve(result);
				};
				const abortWith = (reason, message) => {
					stream.destroy(new Error(message));
					finish({
						reason,
						message,
						total
					});
				};
				stream.on("data", (piece) => {
					if (settled) return;
					total += piece.length;
					produced = total;
					if (alreadyDecompressed + total > ctx.maxDecompressed) {
						abortWith("cap", `decompressed output exceeds ${ctx.maxDecompressed} bytes (small-log scan limit)`);
						return;
					}
					if (ctx.signal?.aborted === true) {
						abortWith("aborted", "scan aborted during decode");
						return;
					}
					if (ctx.now() > ctx.deadlineAt) {
						abortWith("limit", "scan decode exceeded time budget");
						return;
					}
					const fed = onChunk(piece);
					if (fed !== void 0) {
						abortWith(fed.reason, fed.message);
						return;
					}
				});
				stream.on("end", () => {
					if (!settled) finish({ total });
				});
				stream.on("error", (error) => {
					if (settled) return;
					if (ctx.signal?.aborted === true) {
						finish({
							reason: "aborted",
							message: "scan aborted during decode",
							total
						});
						return;
					}
					if (ctx.now() > ctx.deadlineAt) {
						finish({
							reason: "limit",
							message: "scan decode exceeded time budget",
							total
						});
						return;
					}
					finish({
						reason: "corrupt",
						message: `session ${sessionId}: zstd frame failed to decode: ${error.message}`,
						total
					});
				});
				stream.write(frame);
				stream.end();
			});
		}, ctx, {
			lease,
			policy: "external-owned",
			onExpire: () => stream?.destroy(/* @__PURE__ */ new Error("scan decode expired"))
		});
		if (raced.kind === "value") return raced.value;
		if (raced.kind === "error") return {
			reason: "unreadable",
			message: `session ${sessionId}: zstd decode failed to start: ${raced.error instanceof Error ? raced.error.message : String(raced.error)}`,
			total: produced
		};
		if (raced.kind === "busy") {
			stream?.destroy(/* @__PURE__ */ new Error("io budget exhausted"));
			return {
				reason: "limit",
				message: "io budget exhausted during decode",
				total: produced
			};
		}
		return {
			reason: raced.reason,
			message: "scan decode expired",
			total: produced,
			pending: raced.op
		};
	}
	/** 时限/中断门：await 前后都要过（超时/中断 → limit/aborted）。 */
	chunkGate(ctx) {
		if (ctx.signal?.aborted === true) return {
			reason: "aborted",
			error: "header read aborted"
		};
		if (ctx.now() > ctx.deadlineAt) return {
			reason: "limit",
			error: "header read exceeded time budget"
		};
	}
	/** plain JSONL：读到首个换行即停；每次读取不超过剩余输入配额；IO 与到期竞速。 */
	async readPlainFirstLine(handle, sessionId, ctx, lease) {
		const chunks = [];
		const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
		let total = 0;
		let remaining = ctx.maxCompressed;
		for (;;) {
			const gate = this.chunkGate(ctx);
			if (gate !== void 0) return {
				reason: gate.reason,
				error: gate.error,
				stats: {
					bytesCompressed: total,
					bytesDecompressed: 0
				}
			};
			if (remaining <= 0) return {
				reason: "limit",
				error: `no header line within ${ctx.maxCompressed} compressed bytes`,
				stats: {
					bytesCompressed: total,
					bytesDecompressed: 0
				}
			};
			const read = await this.raceOp(() => handle.read(chunk, 0, Math.min(chunk.length, remaining), null), ctx, {
				lease,
				policy: "external-owned"
			});
			if (read.kind === "busy") return {
				reason: "limit",
				error: "io budget exhausted during read",
				stats: {
					bytesCompressed: total,
					bytesDecompressed: 0
				}
			};
			if (read.kind === "expired") return {
				reason: read.reason,
				error: "header read expired during read",
				stats: {
					bytesCompressed: total,
					bytesDecompressed: 0
				},
				pending: read.op
			};
			if (read.kind === "error") return {
				reason: "unreadable",
				error: `session ${sessionId}: log read failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`,
				stats: {
					bytesCompressed: total,
					bytesDecompressed: 0
				}
			};
			const { bytesRead } = read.value;
			const after = this.chunkGate(ctx);
			if (after !== void 0) return {
				reason: after.reason,
				error: after.error,
				stats: {
					bytesCompressed: total + bytesRead,
					bytesDecompressed: 0
				}
			};
			if (bytesRead === 0) return {
				reason: "corrupt",
				error: `session ${sessionId}: log has no complete header line`,
				stats: {
					bytesCompressed: total,
					bytesDecompressed: 0
				}
			};
			const slice = chunk.subarray(0, bytesRead);
			total += bytesRead;
			remaining -= bytesRead;
			const newline = slice.indexOf(10);
			if (newline !== -1) {
				const parts = newline === 0 ? chunks : [...chunks, slice.subarray(0, newline)];
				const line = Buffer.concat(parts);
				if (line.length > ctx.maxDecompressed) return {
					reason: "limit",
					error: `header line exceeds ${ctx.maxDecompressed} decompressed bytes`,
					stats: {
						bytesCompressed: total,
						bytesDecompressed: line.length
					}
				};
				return {
					line: line.toString("utf8"),
					stats: {
						bytesCompressed: total,
						bytesDecompressed: line.length
					}
				};
			}
			chunks.push(Buffer.from(slice));
		}
	}
	/** zstd：扫首个完整独立 frame（输入配额内），流式解压、输出累计到上限即停。 */
	async readZstdFirstLine(handle, sessionId, ctx, lease) {
		if (this.deps.zstd === void 0) return {
			reason: "unsupported",
			error: `session ${sessionId}: zstd log but node:zlib zstd unavailable`,
			stats: {
				bytesCompressed: 0,
				bytesDecompressed: 0
			}
		};
		let content = Buffer.alloc(0);
		const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
		let remaining = ctx.maxCompressed;
		let frameEnd;
		for (;;) {
			const gate = this.chunkGate(ctx);
			if (gate !== void 0) return {
				reason: gate.reason,
				error: gate.error,
				stats: {
					bytesCompressed: content.length,
					bytesDecompressed: 0
				}
			};
			if (remaining <= 0) return {
				reason: "limit",
				error: `no complete first zstd frame within ${ctx.maxCompressed} compressed bytes`,
				stats: {
					bytesCompressed: content.length,
					bytesDecompressed: 0
				}
			};
			const read = await this.raceOp(() => handle.read(chunk, 0, Math.min(chunk.length, remaining), null), ctx, {
				lease,
				policy: "external-owned"
			});
			if (read.kind === "busy") return {
				reason: "limit",
				error: "io budget exhausted during read",
				stats: {
					bytesCompressed: content.length,
					bytesDecompressed: 0
				}
			};
			if (read.kind === "expired") return {
				reason: read.reason,
				error: "header read expired during read",
				stats: {
					bytesCompressed: content.length,
					bytesDecompressed: 0
				},
				pending: read.op
			};
			if (read.kind === "error") return {
				reason: "unreadable",
				error: `session ${sessionId}: log read failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`,
				stats: {
					bytesCompressed: content.length,
					bytesDecompressed: 0
				}
			};
			const { bytesRead } = read.value;
			const after = this.chunkGate(ctx);
			if (after !== void 0) return {
				reason: after.reason,
				error: after.error,
				stats: {
					bytesCompressed: content.length + bytesRead,
					bytesDecompressed: 0
				}
			};
			if (bytesRead === 0) return {
				reason: "corrupt",
				error: `session ${sessionId}: no complete first zstd frame`,
				stats: {
					bytesCompressed: content.length,
					bytesDecompressed: 0
				}
			};
			content = Buffer.concat([content, chunk.subarray(0, bytesRead)]);
			remaining -= bytesRead;
			const scan = scanZstdFrame(content, 0);
			if (scan.error !== void 0) return {
				reason: "corrupt",
				error: `session ${sessionId}: corrupt Zstandard log: ${scan.error}`,
				stats: {
					bytesCompressed: content.length,
					bytesDecompressed: 0
				}
			};
			if (scan.frame !== void 0) {
				frameEnd = scan.frame.end;
				break;
			}
		}
		const decoded = await this.streamDecode(content.subarray(0, frameEnd), sessionId, ctx, lease);
		if ("reason" in decoded) return decoded;
		const plaintext = decoded.plaintext;
		if (plaintext.length === 0 || plaintext.indexOf(10) !== plaintext.length - 1) return {
			reason: "corrupt",
			error: `session ${sessionId}: first zstd frame is not exactly one header line`,
			stats: {
				bytesCompressed: content.length,
				bytesDecompressed: plaintext.length
			}
		};
		return {
			line: plaintext.subarray(0, -1).toString("utf8"),
			stats: {
				bytesCompressed: content.length,
				bytesDecompressed: plaintext.length
			}
		};
	}
	/** 流式解码一个完整 frame；输出/时限/中断任一越界即销毁流并关死。 */
	async streamDecode(frame, sessionId, ctx, lease) {
		let stream;
		const raced = await this.raceOp(() => {
			stream = this.deps.zstd.createStream();
			return this.decodeFrame(stream, frame, sessionId, ctx);
		}, ctx, {
			lease,
			policy: "external-owned",
			onExpire: () => stream?.destroy(/* @__PURE__ */ new Error("header decode expired"))
		});
		if (raced.kind === "value") return raced.value;
		if (raced.kind === "error") return {
			reason: "unreadable",
			error: `session ${sessionId}: zstd decode failed: ${raced.error instanceof Error ? raced.error.message : String(raced.error)}`,
			stats: {
				bytesCompressed: frame.length,
				bytesDecompressed: 0
			}
		};
		if (raced.kind === "busy") {
			stream?.destroy(/* @__PURE__ */ new Error("io budget exhausted"));
			return {
				reason: "limit",
				error: "io budget exhausted during decode",
				stats: {
					bytesCompressed: frame.length,
					bytesDecompressed: 0
				}
			};
		}
		return {
			reason: raced.reason,
			error: "header decode expired",
			stats: {
				bytesCompressed: frame.length,
				bytesDecompressed: 0
			},
			pending: raced.op
		};
	}
	/** 解码一个 frame（流事件 → 结果 promise）。 */
	decodeFrame(stream, frame, sessionId, ctx) {
		return new Promise((resolve) => {
			const parts = [];
			let total = 0;
			let settled = false;
			const finish = (result) => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			const abortWith = (reason, error, bytesDecompressed) => {
				stream.destroy(new Error(error));
				finish({
					reason,
					error,
					stats: {
						bytesCompressed: frame.length,
						bytesDecompressed
					}
				});
			};
			stream.on("data", (piece) => {
				if (settled) return;
				total += piece.length;
				if (total > ctx.maxDecompressed) {
					abortWith("limit", `header frame exceeds ${ctx.maxDecompressed} decompressed bytes`, total);
					return;
				}
				if (ctx.signal?.aborted === true) {
					abortWith("aborted", "header read aborted", total);
					return;
				}
				if (ctx.now() > ctx.deadlineAt) {
					abortWith("limit", "header decode exceeded time budget", total);
					return;
				}
				parts.push(piece);
			});
			stream.on("end", () => {
				if (settled) return;
				if (ctx.signal?.aborted === true) {
					abortWith("aborted", "header read aborted", total);
					return;
				}
				if (ctx.now() > ctx.deadlineAt) {
					abortWith("limit", "header decode exceeded time budget", total);
					return;
				}
				finish({
					plaintext: Buffer.concat(parts),
					bytesDecompressed: total
				});
			});
			stream.on("error", (error) => {
				if (settled) return;
				if (ctx.signal?.aborted === true) {
					finish({
						reason: "aborted",
						error: "header read aborted",
						stats: {
							bytesCompressed: frame.length,
							bytesDecompressed: total
						}
					});
					return;
				}
				if (ctx.now() > ctx.deadlineAt) {
					finish({
						reason: "limit",
						error: "header decode exceeded time budget",
						stats: {
							bytesCompressed: frame.length,
							bytesDecompressed: total
						}
					});
					return;
				}
				finish({
					reason: "corrupt",
					error: `session ${sessionId}: first zstd frame failed to decode: ${error.message}`,
					stats: {
						bytesCompressed: frame.length,
						bytesDecompressed: total
					}
				});
			});
			stream.write(frame);
			stream.end();
		});
	}
};

//#endregion
//#region src/host/session/session-index.ts
/** 保存去抖窗口。 */
const SAVE_DEBOUNCE_MS = 2e3;
/** 单次头读取的时间预算。 */
const READ_DEADLINE_MS = 2e3;
/** 枚举时的礼让间隔（每 N 个会话让一轮事件循环）。 */
const ENUMERATE_YIELD_EVERY = 100;
function isENOENT(error) {
	return error !== null && typeof error === "object" && error.code === "ENOENT";
}
function defaultSchedule(delayMs, fn) {
	const timer = setTimeout(() => fn(), delayMs);
	timer.unref?.();
	return () => clearTimeout(timer);
}
/**
* 冷盘头 → 判定（C1 修订：撤销「v4 权威头」假设）。官方
* persistence-catalog 明确 `agent-preset/selected` 记录创建后在空白会话上的
* 选择、恢复/fork 采用它而非 creation-time 值——**任何版本**的 creation
* header 都可能是被覆盖的旧值。因此冷盘（无 live 权威投影）只能安全证明
* seeded 排除；其余一律显式 unknown，绝不冒充 router/nonrouter 去驱动
* pin/归档。
*/
function classifyDiskFacts(facts) {
	if (facts.isSeeded) return {
		verdict: "nonrouter",
		reason: "seeded session excluded"
	};
	return {
		verdict: "unknown",
		reason: "cold session: creation header is not authoritative (agent-preset/selected may override it); no live projection available"
	};
}
/**
* live 权威组合 → 判定。finalPreset 来自已 live Session 的投影/已提交选择
* 事件：等于 router 预设 → router；任何其他确定值（含 null = 无预设组合）→
* nonrouter；读不到权威值（undefined）→ unknown。
*/
function classifyLiveComposition(finalPreset, isSeeded, routerPreset) {
	if (isSeeded) return {
		verdict: "nonrouter",
		reason: "seeded session excluded"
	};
	if (finalPreset === routerPreset) return {
		verdict: "router",
		reason: void 0
	};
	if (finalPreset === void 0) return {
		verdict: "unknown",
		reason: "live authoritative composition unavailable"
	};
	return {
		verdict: "nonrouter",
		reason: finalPreset === null ? "preset-free live composition" : `live composition runs under ${finalPreset}`
	};
}
/** live Session 载荷的头事实（防御性读 `session.header`；`session.id` 兜底）。 */
function liveHeaderOf(session) {
	if (session === null || typeof session !== "object") return void 0;
	const carrier = session;
	const header = carrier.header;
	const record = header !== null && typeof header === "object" ? header : session;
	const id = typeof record["id"] === "string" && record["id"].length > 0 ? record["id"] : typeof carrier.id === "string" && carrier.id.length > 0 ? carrier.id : void 0;
	if (id === void 0) return void 0;
	if (typeof record["version"] !== "number" || typeof record["createdAt"] !== "number") return void 0;
	if (typeof record["isSeeded"] !== "boolean") return void 0;
	if (record["agentPreset"] !== void 0 && typeof record["agentPreset"] !== "string") return void 0;
	return {
		id,
		version: record["version"],
		createdAt: record["createdAt"],
		isSeeded: record["isSeeded"],
		agentPreset: record["agentPreset"]
	};
}
/** live Session 载荷的会话 id（头优先，载荷 id 兜底）。 */
function liveSessionId(session) {
	if (session === null || typeof session !== "object") return void 0;
	const carrier = session;
	const header = carrier.header;
	const record = header !== null && typeof header === "object" ? header : session;
	return typeof record["id"] === "string" && record["id"].length > 0 ? record["id"] : typeof carrier.id === "string" && carrier.id.length > 0 ? carrier.id : void 0;
}
/** 目录名清单 →（追踪用最高 generation，全部规范 generation 名的有序集合键）。 */
function pickGenerationForTracking(names) {
	const canonical = [];
	let chosen;
	for (const name$1 of names) {
		const parsed = parseGenerationFilename(name$1);
		if (parsed === void 0) continue;
		canonical.push(name$1);
		if (chosen === void 0 || parsed.version > chosen.version || parsed.version === chosen.version && parsed.name > chosen.name) chosen = parsed;
	}
	if (chosen === void 0) return void 0;
	return {
		...chosen,
		namesKey: canonical.sort().join("|")
	};
}
function fingerprintOf(stat$1, namesKey) {
	return `${stat$1.dev}:${stat$1.ino}:${stat$1.mtimeMs}:${stat$1.ctimeMs}:${stat$1.size}:${namesKey}`;
}
/**
* 增量会话候选索引。单实例负责一个 root + preset 作用域；所有公开异步入口
* 先 `await hydrate()`（幂等单飞）再经内部串行链执行。
*/
var SessionHeaderIndex = class {
	root;
	routerPreset;
	reader;
	fs;
	persistence;
	resolveLivePreset;
	membership;
	logger;
	now;
	scheduleFn;
	batchAttempts;
	failureRetryMs;
	reconcileIntervalMs;
	backgroundIntervalMs;
	entries = /* @__PURE__ */ new Map();
	failures = /* @__PURE__ */ new Map();
	/** I8 r2：追加式队列 + 游标（出队是墓碑标记 + 惰性压实，不整体搬移）。 */
	queueItems = [];
	queueHead = 0;
	queued = /* @__PURE__ */ new Set();
	queuedCount = 0;
	/** 到期重试调度（O(1) 判定，不逐 tick 扫全 failures）。 */
	nextRetryAt = Number.POSITIVE_INFINITY;
	/** 到期失败最小堆（惰性失效；批量删除/改期不退化成平方）。 */
	retryHeap = [];
	/** 期限重算时访问的失败条目数（护栏：批量删除不得退化成平方）。 */
	failureDeadlineScanCount = 0;
	/** 优先名单的轮转游标（有界窗口扫描；不从头全扫）。 */
	prioritizeCursor = 0;
	pendingLocs = /* @__PURE__ */ new Map();
	hydratePromise;
	hydrated = false;
	/** hydrate 落定前到达的 live 更新排队（载入的旧盘判定不得覆盖新 live 事实）。 */
	liveQueue = [];
	/** 每会话 live 事实版本号：在途盘读完成后对照，旧 IO 不得覆盖新事实（I2）。 */
	revisions = /* @__PURE__ */ new Map();
	/**
	* I10 r2：hydrate 载入的缓存条目在未经成功对账核对位置指纹前保持
	* unverified——verdictOf 一律 pending（不授权 pin/归档/收编）；成功核对
	* 指纹、或经 live 权威事实/新盘读产生，才移出本集。
	*/
	unverified = /* @__PURE__ */ new Set();
	chain = Promise.resolve();
	inflightReconcile;
	inflightAdvance;
	abortController = new AbortController();
	ioBudget;
	disposed = false;
	started = false;
	stopBackground;
	lastReconcileAt;
	lastReconcileError;
	initialDone = false;
	/** I8 r2：宿主成员/归档集快照（低频刷新 + live 事件失效）。 */
	membershipSnapshot = [];
	archivedSnapshot = /* @__PURE__ */ new Set();
	membershipStale = true;
	/**
	* 成员快照版本号：**只在成员/归档内容变化时前进**。判定版本号会因任何
	* 判定变化而前进，不能用来缓存成员名单——那会让消费方每轮重建全成员
	* 名单，分批收敛时累计成平方。
	*/
	membershipRevisionCounter = 1;
	/**
	* 成员定位表（sessionId → workspaceId）：**增量缓存**，只在成员快照刷新
	* 时重建（低频对账 / 成员失效刷新）。收编侧据此 O(1) 定位目标工作区，
	* 稳态轮次不再遍历宿主全部工作区/会话（review I7）。
	*/
	membershipIndex = /* @__PURE__ */ new Map();
	/**
	* router 资格授予（review I1 + I7 round 2）：`grantState` 是每个 id 的资格
	* 记录（代数 + 当前是否成立）；`pendingGrants` 装**未被领取**的授予（新事实，
	* 插入序；稳态为空 → 每轮 O(1)）；`claimedGrants` 装**已被消费方领取但尚未
	* ack** 的授予（消费方正在自行排期重试的那些 —— 不再参与每轮枚举）。
	* 资格"不再成立"时两侧都撤下；"又成立"时发**新一代**授予（回未领取面）。
	*/
	grantState = /* @__PURE__ */ new Map();
	pendingGrants = /* @__PURE__ */ new Map();
	claimedGrants = /* @__PURE__ */ new Map();
	eligibilitySeq = 0;
	/**
	* live 实例身份（生命周期 token）：`session/created` 认领当前实例；被替换
	* 的旧实例进 `retiredInstances`（弱引用集）——旧实例的迟到事件与 disposed
	* 都不再影响新实例（review I6）。
	*
	* 事件面的身份检查是**兼容护栏**而不是事实假设：已核实的当前宿主在
	* created / event / disposed 三处传的是**同一个 Session 实例**，因此严格
	* 比对是可靠的；这里对"未被认领过的其它对象"保持宽容，只是为了将来宿主
	* 改用包装对象投递时不至于丢掉权威事件（旧实例仍被退休集挡住）。
	*/
	liveInstances = /* @__PURE__ */ new Map();
	retiredInstances = /* @__PURE__ */ new WeakSet();
	/**
	* 生命周期代际（授权屏障）：判定/权威事实每变一次 +1。消费方在 await
	* 前后比对同一代数，识别"计划已过期"的异步间隙（review I5/I6）。
	*/
	authorityTokens = /* @__PURE__ */ new Map();
	dirty = false;
	/** 判定状态版本号：任一判定/队列/失败变化时前进（dedup 稳态缓存键，I8）。 */
	stateRevision = 1;
	/** 变更序号：保存期间的新变更使序号前进，成功回调据此保留 dirty（I6）。 */
	mutationSeq = 0;
	/** 首个未落盘变更的固定保存期限（后续轮询不推迟，I6）。 */
	saveDueAt;
	saveTimerCancel;
	saveRunning = false;
	saveChain = Promise.resolve();
	counters = {
		headerAttempts: 0,
		headerErrors: 0,
		cacheReused: 0,
		bytesCompressed: 0,
		bytesDecompressed: 0,
		reconcileRuns: 0,
		advanceRuns: 0,
		scanAttempts: 0,
		scanFinals: 0,
		scanCaps: 0,
		scanUnstable: 0,
		grantVisits: 0
	};
	constructor(deps) {
		this.ioBudget = new IoBudget(deps.ioCapacity ?? 8);
		this.root = deps.root;
		this.routerPreset = deps.routerPreset;
		this.reader = deps.reader ?? new SessionHeaderReader(void 0, { budget: this.ioBudget });
		this.fs = deps.fs ?? {
			readdir: (dir) => readdir(dir, { withFileTypes: true }),
			stat: (path) => stat(path)
		};
		this.persistence = deps.persistence;
		this.resolveLivePreset = deps.resolveLivePreset;
		this.membership = deps.membership;
		this.logger = deps.logger;
		this.now = deps.now ?? Date.now;
		this.scheduleFn = deps.schedule ?? defaultSchedule;
		this.batchAttempts = deps.batchAttempts ?? 10;
		this.failureRetryMs = deps.failureRetryMs ?? 10 * 6e4;
		this.reconcileIntervalMs = deps.reconcileIntervalMs ?? 6e4;
		this.backgroundIntervalMs = deps.backgroundIntervalMs ?? 250;
	}
	warn(message) {
		this.logger?.warn(message);
	}
	/** 载入持久化判定（幂等单飞；作用域不符/损坏整份丢弃）。 */
	hydrate() {
		if (this.hydratePromise !== void 0) return this.hydratePromise;
		this.hydratePromise = this.hydrateOnce();
		return this.hydratePromise;
	}
	async hydrateOnce() {
		try {
			if (this.persistence !== void 0) {
				let loaded;
				try {
					loaded = await this.persistence.load();
				} catch (error) {
					this.warn(`候选索引载入失败（忽略，按全新开始）: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (isValidStateFile(loaded, this.root, this.routerPreset)) {
					const legacyFile = loaded.version === 1;
					for (const entry of loaded.entries) {
						if (!isValidEntry(entry, this.routerPreset) || entry.origin !== "disk") continue;
						if (legacyFile && !(entry.verdict === "nonrouter" && entry.isSeeded === true)) continue;
						this.unverified.add(entry.sessionId);
						this.putEntry(entry.sessionId, { ...entry });
					}
					for (const failure of loaded.failures) {
						if (!isValidFailure(failure)) continue;
						this.failures.set(failure.sessionId, { ...failure });
						this.retryHeapPush(failure.sessionId, failure.retryAt);
					}
					this.recomputeNextRetryAt();
					this.markDirty();
				}
			}
		} finally {
			this.hydrated = true;
			const queued = this.liveQueue.splice(0);
			for (const thunk of queued) {
				if (this.disposed) break;
				thunk();
			}
		}
	}
	/** 串行链：所有实际工作经此排队执行。 */
	enqueue(work) {
		const run = this.chain.then(work, work);
		this.chain = run.catch(() => void 0);
		return run;
	}
	/**
	* 目录对账：全量枚举 root 的会话目录（O(N) 元数据），按成员 + 指纹维护
	* 条目/队列/失败。单飞：并发调用并入同一轮。
	*/
	reconcile() {
		if (this.inflightReconcile !== void 0) return this.inflightReconcile;
		this.inflightReconcile = this.enqueue(async () => {
			try {
				await this.reconcileOnce();
			} finally {
				this.inflightReconcile = void 0;
			}
		});
		return this.inflightReconcile;
	}
	async reconcileOnce() {
		await this.hydrate();
		if (this.disposed) return;
		this.counters.reconcileRuns += 1;
		const enumeration = await this.enumerate();
		if (this.disposed) return;
		const discovered = enumeration.discovered;
		this.lastReconcileError = enumeration.error;
		if (enumeration.error !== void 0) this.warn(`候选索引对账不完整（保留既有条目）: ${enumeration.error}`);
		if (enumeration.error === void 0) {
			for (const [id, entry] of this.entries) {
				if (entry.origin === "live") continue;
				if (!discovered.has(id)) {
					this.dropEntry(id);
					this.dequeue(id);
					this.failures.delete(id);
					this.forgetSessionAuxiliaries(id);
					this.recomputeNextRetryAt();
					this.markDirty();
				}
			}
			for (const id of [...this.failures.keys()]) if (!discovered.has(id)) {
				this.failures.delete(id);
				this.recomputeNextRetryAt();
				this.markDirty();
			}
		}
		for (const [id, loc] of discovered) {
			const existing = this.entries.get(id);
			if (existing !== void 0) {
				if (existing.origin === "live") {
					if (existing.file !== loc.file || existing.fingerprint !== loc.fingerprint) {
						existing.projectDir = loc.projectDir;
						existing.file = loc.file;
						existing.fingerprint = loc.fingerprint;
						this.markDirty();
					}
					continue;
				}
				if (existing.fingerprint === loc.fingerprint && existing.file === loc.file && existing.projectDir === loc.projectDir) {
					this.counters.cacheReused += 1;
					if (this.unverified.delete(id)) {
						this.markDirty();
						this.syncRouterGrant(id);
					}
					continue;
				}
				this.dropEntry(id);
				this.enqueueForClassification(id, loc);
				continue;
			}
			const failure = this.failures.get(id);
			if (failure !== void 0) {
				if (failure.file !== loc.file || failure.fingerprint !== loc.fingerprint) {
					failure.projectDir = loc.projectDir;
					failure.file = loc.file;
					failure.fingerprint = loc.fingerprint;
					this.markDirty();
				}
				continue;
			}
			this.enqueueForClassification(id, loc);
		}
		this.refreshMembership();
		this.lastReconcileAt = this.now();
		this.initialDone = true;
		this.scheduleSave();
	}
	/**
	* 枚举 root 下的会话位置（项目目录/会话目录名排序保证确定性）。
	* M1：区分 ENOENT（不存在=空库）与其他读错误（partial，附 error 说明）。
	*/
	async enumerate() {
		const discovered = /* @__PURE__ */ new Map();
		let error;
		let projects;
		const rootListing = await this.boundedIo(() => this.fs.readdir(this.root));
		if ("expired" in rootListing) {
			if (rootListing.expired === "abort") return {
				discovered,
				error
			};
			return {
				discovered,
				error: `sessions root unreadable: io ${rootListing.expired}`
			};
		}
		if ("error" in rootListing) {
			if (!isENOENT(rootListing.error)) error = `sessions root unreadable: ${rootListing.error instanceof Error ? rootListing.error.message : String(rootListing.error)}`;
			return {
				discovered,
				error
			};
		}
		projects = rootListing.value;
		let seen = 0;
		for (const project of [...projects].sort((a, b) => a.name < b.name ? -1 : 1)) {
			if (this.disposed || this.abortController.signal.aborted) return {
				discovered,
				error
			};
			if (!project.isDirectory()) continue;
			const projectListing = await this.boundedIo(() => this.fs.readdir(join(this.root, project.name)));
			if ("expired" in projectListing) {
				if (projectListing.expired === "abort") return {
					discovered,
					error
				};
				error = `project dir unreadable: ${project.name}: io ${projectListing.expired}`;
				continue;
			}
			if ("error" in projectListing) {
				if (!isENOENT(projectListing.error)) error = `project dir unreadable: ${project.name}: ${projectListing.error instanceof Error ? projectListing.error.message : String(projectListing.error)}`;
				continue;
			}
			const sessionDirs = projectListing.value;
			for (const sessionDir of [...sessionDirs].sort((a, b) => a.name < b.name ? -1 : 1)) {
				if (!sessionDir.isDirectory()) continue;
				const sessionId = decodeSegment(sessionDir.name);
				if (sessionId === void 0 || sessionId.length === 0) continue;
				const dirPath = join(this.root, project.name, sessionDir.name);
				const sessionListing = await this.boundedIo(() => this.fs.readdir(dirPath));
				if ("expired" in sessionListing) {
					if (sessionListing.expired === "abort") return {
						discovered,
						error
					};
					error = `session dir unreadable: ${sessionDir.name}: io ${sessionListing.expired}`;
					continue;
				}
				if ("error" in sessionListing) {
					if (!isENOENT(sessionListing.error)) error = `session dir unreadable: ${sessionDir.name}: ${sessionListing.error instanceof Error ? sessionListing.error.message : String(sessionListing.error)}`;
					continue;
				}
				const chosen = pickGenerationForTracking(sessionListing.value.map((entry) => entry.name));
				if (chosen === void 0) continue;
				const stattedLog = await this.boundedIo(() => this.fs.stat(join(dirPath, chosen.name)));
				if ("expired" in stattedLog) {
					if (stattedLog.expired === "abort") return {
						discovered,
						error
					};
					error = `session log unstattable: ${sessionDir.name}: io ${stattedLog.expired}`;
					continue;
				}
				if ("error" in stattedLog) {
					if (!isENOENT(stattedLog.error)) error = `session log unstattable: ${sessionDir.name}: ${stattedLog.error instanceof Error ? stattedLog.error.message : String(stattedLog.error)}`;
					continue;
				}
				const stat$1 = stattedLog.value;
				discovered.set(sessionId, {
					projectDir: project.name,
					file: chosen.name,
					fingerprint: fingerprintOf(stat$1, chosen.namesKey)
				});
				seen += 1;
				if (seen % ENUMERATE_YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
				if (this.disposed || this.abortController.signal.aborted) return {
					discovered,
					error
				};
			}
		}
		return {
			discovered,
			error
		};
	}
	/**
	* 有界推进一批分类：全局尝试预算（含失败读取）；`prioritize` 把指定会话
	* 提到队首（供去重按 workspace 成员加速收敛）。单飞：并发调用并入同一轮。
	*/
	advance(options = {}) {
		if (this.inflightAdvance !== void 0) return this.inflightAdvance;
		this.inflightAdvance = this.enqueue(async () => {
			try {
				await this.advanceOnce(options.prioritize ?? []);
			} finally {
				this.inflightAdvance = void 0;
			}
		});
		return this.inflightAdvance;
	}
	async advanceOnce(prioritize) {
		await this.hydrate();
		if (this.disposed) return;
		this.counters.advanceRuns += 1;
		if (this.queuedCount === 0 && this.now() < this.nextRetryAt) {
			this.scheduleSave();
			return;
		}
		const ids = [];
		const seenIds = /* @__PURE__ */ new Set();
		const push = (id) => {
			if (!seenIds.has(id)) {
				seenIds.add(id);
				ids.push(id);
			}
		};
		const dueNow = this.now() >= this.nextRetryAt;
		if (prioritize.length > 0) {
			const scanSpan = Math.min(prioritize.length, Math.max(this.batchAttempts, 1));
			const start = this.prioritizeCursor % prioritize.length;
			for (let i = 0; i < scanSpan; i += 1) {
				if (ids.length >= this.batchAttempts) break;
				const id = prioritize[(start + i) % prioritize.length];
				if (this.queued.has(id) || dueNow && this.failureDue(id)) push(id);
			}
			this.prioritizeCursor = (start + scanSpan) % prioritize.length;
		}
		for (let i = this.queueHead; i < this.queueItems.length; i += 1) {
			if (ids.length >= this.batchAttempts) break;
			const id = this.queueItems[i];
			if (this.queued.has(id)) push(id);
		}
		let claimedDue = [];
		if (dueNow && ids.length < this.batchAttempts) claimedDue = this.collectDueFailures(this.batchAttempts - ids.length, ids, seenIds);
		let attempts = 0;
		for (const id of ids) {
			if (attempts >= this.batchAttempts) break;
			if (this.disposed || this.abortController.signal.aborted) break;
			const loc = this.pendingLocs.get(id) ?? this.failureLocation(id);
			if (loc === void 0) continue;
			attempts += 1;
			this.counters.headerAttempts += 1;
			const revisionBefore = this.revisions.get(id) ?? 0;
			const dir = join(this.root, loc.projectDir, encodeSegment(id));
			let outcome;
			try {
				outcome = await this.reader.readSessionHeader(dir, id, {
					signal: this.abortController.signal,
					now: this.now,
					deadlineAt: this.now() + READ_DEADLINE_MS,
					timer: { set: (delayMs, fn) => this.scheduleFn(delayMs, fn) }
				});
			} catch (error) {
				if (this.abortController.signal.aborted || this.disposed) break;
				outcome = {
					ok: false,
					reason: "unreadable",
					message: error instanceof Error ? error.message : String(error),
					stats: {
						bytesCompressed: 0,
						bytesDecompressed: 0
					}
				};
			}
			if ((this.revisions.get(id) ?? 0) !== revisionBefore) {
				this.dequeue(id);
				this.markDirty();
				continue;
			}
			let scan;
			if (outcome.ok && !outcome.header.isSeeded && outcome.header.version === MAX_KNOWN_SESSION_VERSION && this.reader.scanSessionLog !== void 0) {
				this.counters.scanAttempts += 1;
				try {
					scan = await this.reader.scanSessionLog(dir, id, {
						signal: this.abortController.signal,
						now: this.now,
						deadlineAt: this.now() + READ_DEADLINE_MS,
						timer: { set: (delayMs, fn) => this.scheduleFn(delayMs, fn) }
					});
				} catch (error) {
					if (this.abortController.signal.aborted || this.disposed) break;
					scan = {
						ok: false,
						reason: "unreadable",
						message: error instanceof Error ? error.message : String(error),
						stats: {
							bytesCompressed: 0,
							bytesDecompressed: 0,
							lines: 0
						}
					};
				}
				if ((this.revisions.get(id) ?? 0) !== revisionBefore || this.disposed) {
					this.dequeue(id);
					this.markDirty();
					continue;
				}
			}
			const fingerprint = await this.fingerprintVerdict(id, loc);
			if ((this.revisions.get(id) ?? 0) !== revisionBefore || this.disposed) {
				this.dequeue(id);
				this.markDirty();
				continue;
			}
			if (fingerprint.kind !== "unchanged") {
				this.dequeue(id);
				if (fingerprint.kind === "changed") {
					if (this.failures.delete(id)) this.recomputeNextRetryAt();
					this.markDirty();
					continue;
				}
				if (fingerprint.kind === "gone") {
					this.dropEntry(id);
					if (this.failures.delete(id)) this.recomputeNextRetryAt();
					this.markDirty();
					continue;
				}
				this.scheduleFailure(id, loc, fingerprint.message);
				this.markDirty();
				continue;
			}
			if (this.abortController.signal.aborted && (!outcome.ok || outcome.reason === "aborted" || scan !== void 0 && !scan.ok && scan.reason === "aborted")) break;
			this.counters.bytesCompressed += outcome.stats.bytesCompressed + (scan !== void 0 ? scan.stats.bytesCompressed : 0);
			this.counters.bytesDecompressed += outcome.stats.bytesDecompressed + (scan !== void 0 ? scan.stats.bytesDecompressed : 0);
			if (scan !== void 0) {
				if (scan.ok) {
					if (!this.scanEvidenceMatchesIndex(scan, loc, fingerprint)) {
						this.scheduleFailure(id, loc, "stable-eof scan evidence does not match the indexed file identity");
						this.dequeue(id);
						this.markDirty();
						continue;
					}
					this.counters.scanFinals += 1;
					const isRouter = scan.finalPreset === this.routerPreset;
					const reason = scan.stats.lines === 0 ? "stable-eof snapshot from creation header (header-only log; current state, rescan on change)" : isRouter ? void 0 : scan.finalPreset === null ? "stable-eof: preset-free composition" : `stable-eof: runs under ${scan.finalPreset}`;
					this.unverified.delete(id);
					this.putEntry(id, {
						sessionId: id,
						projectDir: loc.projectDir,
						file: loc.file,
						fingerprint: loc.fingerprint,
						verdict: isRouter ? "router" : "nonrouter",
						createdAt: scan.header.createdAt,
						isSeeded: scan.header.isSeeded,
						agentPreset: scan.finalPreset === null ? void 0 : scan.finalPreset,
						origin: "disk",
						reason,
						evidence: "stable-eof"
					});
					if (this.failures.delete(id)) this.recomputeNextRetryAt();
					this.dequeue(id);
					this.markDirty();
					continue;
				}
				if (scan.reason === "unstable") this.counters.scanUnstable += 1;
				if (scan.reason === "cap") this.counters.scanCaps += 1;
				if (scan.reason === "aborted") break;
				if (scan.reason === "missing") {
					this.dequeue(id);
					if (this.failures.delete(id)) this.recomputeNextRetryAt();
					this.markDirty();
					continue;
				}
				if (scan.reason === "unstable" || scan.reason === "limit" || scan.reason === "unreadable") {
					this.scheduleFailure(id, loc, `stable-eof scan ${scan.reason}: ${scan.message}`);
					this.dequeue(id);
					this.markDirty();
					continue;
				}
				this.unverified.delete(id);
				this.putEntry(id, {
					sessionId: id,
					projectDir: loc.projectDir,
					file: loc.file,
					fingerprint: loc.fingerprint,
					verdict: "unknown",
					createdAt: void 0,
					isSeeded: void 0,
					agentPreset: void 0,
					origin: "disk",
					reason: `stable-eof scan ${scan.reason}: ${scan.message}`
				});
				if (this.failures.delete(id)) this.recomputeNextRetryAt();
				this.dequeue(id);
				this.markDirty();
				continue;
			}
			if (outcome.ok) {
				const { verdict, reason } = classifyDiskFacts(outcome.header);
				let finalReason = reason;
				if (verdict === "unknown" && !outcome.header.isSeeded) {
					if (outcome.header.version !== MAX_KNOWN_SESSION_VERSION) finalReason = `legacy format v${outcome.header.version}: stable-EOF scan covers current v${MAX_KNOWN_SESSION_VERSION} only`;
					else if (this.reader.scanSessionLog === void 0) finalReason = "stable-EOF scan unavailable on reader face (conservative unknown)";
				}
				this.unverified.delete(id);
				this.putEntry(id, {
					sessionId: id,
					projectDir: loc.projectDir,
					file: loc.file,
					fingerprint: loc.fingerprint,
					verdict,
					createdAt: outcome.header.createdAt,
					isSeeded: outcome.header.isSeeded,
					agentPreset: outcome.header.agentPreset,
					origin: "disk",
					reason: finalReason
				});
				if (this.failures.delete(id)) this.recomputeNextRetryAt();
				this.dequeue(id);
				this.markDirty();
				continue;
			}
			this.counters.headerErrors += 1;
			if (outcome.reason === "aborted") break;
			if (outcome.reason === "missing") {
				this.dequeue(id);
				if (this.failures.delete(id)) this.recomputeNextRetryAt();
				this.markDirty();
				continue;
			}
			if (outcome.reason === "limit" || outcome.reason === "unreadable") {
				this.scheduleFailure(id, loc, outcome.message);
				this.dequeue(id);
				this.markDirty();
				continue;
			}
			this.unverified.delete(id);
			this.putEntry(id, {
				sessionId: id,
				projectDir: loc.projectDir,
				file: loc.file,
				fingerprint: loc.fingerprint,
				verdict: "unknown",
				createdAt: void 0,
				isSeeded: void 0,
				agentPreset: void 0,
				origin: "disk",
				reason: `${outcome.reason}: ${outcome.message}`
			});
			if (this.failures.delete(id)) this.recomputeNextRetryAt();
			this.dequeue(id);
			this.markDirty();
		}
		for (const claim of claimedDue) {
			const failure = this.failures.get(claim.id);
			if (failure !== void 0 && failure.retryAt === claim.retryAt) this.retryHeapPush(claim.id, claim.retryAt);
		}
		if (claimedDue.length > 0) this.recomputeNextRetryAt();
		this.advanceQueueCursor();
		this.scheduleSave();
	}
	/**
	* R2-B r5：从到期堆取最多 `room` 条**当前真实到期**的失败候选（弹出即认
	* 领）。堆内的失效条目（已删除/已改期）惰性剔除；已被优先名单/队列收录的
	* id 弹出后原期限压回（不认领、不丢期限）。调用后重算 nextRetryAt。
	*/
	collectDueFailures(room, ids, seenIds) {
		const claimed = [];
		const pushedBack = [];
		const now = this.now();
		while (claimed.length < room) {
			const top = this.retryHeap[0];
			if (top === void 0 || top.retryAt > now) break;
			this.retryHeapPop();
			const failure = this.failures.get(top.id);
			if (failure === void 0 || failure.retryAt !== top.retryAt) {
				this.failureDeadlineScanCount += 1;
				continue;
			}
			if (seenIds.has(top.id)) {
				pushedBack.push({
					id: top.id,
					retryAt: top.retryAt
				});
				continue;
			}
			seenIds.add(top.id);
			ids.push(top.id);
			claimed.push({
				id: top.id,
				retryAt: top.retryAt
			});
		}
		for (const item of pushedBack) this.retryHeapPush(item.id, item.retryAt);
		this.recomputeNextRetryAt();
		return claimed;
	}
	/**
	* 变更时重算最早到期时刻（R2-B r4）。
	*
	* **绝不逐条全扫 failures**——批量删除 F 条失败时逐条重算会退化成
	* F(F-1)/2 次访问（平方）。改用**最小堆 + 惰性失效**：新增/改期时压入
	* （id, retryAt）；删除/改期使旧条目失效，重算时从堆顶惰性剔除，
	* 均摊 O(log F)。堆内失效条目堆积过多时按当前 failures 重建（均摊 O(1)/次）。
	*/
	recomputeNextRetryAt() {
		for (;;) {
			const top = this.retryHeap[0];
			if (top === void 0) {
				this.nextRetryAt = Number.POSITIVE_INFINITY;
				break;
			}
			const failure = this.failures.get(top.id);
			if (failure !== void 0 && failure.retryAt === top.retryAt) {
				this.nextRetryAt = top.retryAt;
				break;
			}
			this.failureDeadlineScanCount += 1;
			this.retryHeapPop();
		}
		if (this.retryHeap.length > 4 * this.failures.size + 64) this.rebuildRetryHeap();
	}
	/** 压入一条到期期限（最小堆）。 */
	retryHeapPush(id, retryAt) {
		const heap = this.retryHeap;
		heap.push({
			id,
			retryAt
		});
		let i = heap.length - 1;
		while (i > 0) {
			const parent = i - 1 >> 1;
			if (heap[parent].retryAt <= heap[i].retryAt) break;
			const tmp = heap[parent];
			heap[parent] = heap[i];
			heap[i] = tmp;
			i = parent;
		}
	}
	/** 弹出堆顶（最小 retryAt）。 */
	retryHeapPop() {
		const heap = this.retryHeap;
		if (heap.length === 0) return void 0;
		const top = heap[0];
		const last = heap.pop();
		if (heap.length > 0) {
			heap[0] = last;
			this.retryHeapSiftDown(0);
		}
		return top;
	}
	/** 堆内下沉（重建时也用它）。 */
	retryHeapSiftDown(index) {
		const heap = this.retryHeap;
		let i = index;
		for (;;) {
			const left = 2 * i + 1;
			const right = 2 * i + 2;
			let min = i;
			if (left < heap.length && heap[left].retryAt < heap[min].retryAt) min = left;
			if (right < heap.length && heap[right].retryAt < heap[min].retryAt) min = right;
			if (min === i) break;
			const tmp = heap[min];
			heap[min] = heap[i];
			heap[i] = tmp;
			i = min;
		}
	}
	/** 按当前 failures 重建到期堆（堆内失效条目堆积时的均摊摊平）。 */
	rebuildRetryHeap() {
		this.failureDeadlineScanCount += this.failures.size;
		const heap = this.retryHeap;
		heap.length = 0;
		for (const failure of this.failures.values()) heap.push({
			id: failure.sessionId,
			retryAt: failure.retryAt
		});
		for (let i = (heap.length >> 1) - 1; i >= 0; i -= 1) this.retryHeapSiftDown(i);
	}
	/** 游标越过已处理/已墓碑的队头；头部堆积时惰性压实（不整体搬移 backlog）。 */
	advanceQueueCursor() {
		while (this.queueHead < this.queueItems.length && !this.queued.has(this.queueItems[this.queueHead])) this.queueHead += 1;
		if (this.queueHead > 64 && this.queueHead * 2 >= this.queueItems.length) {
			this.queueItems = this.queueItems.slice(this.queueHead).filter((id) => this.queued.has(id));
			this.queueHead = 0;
		}
	}
	/**
	* 读后复核的 typed 结论（R2-B r4）：
	* - `unchanged`：指纹一致 → 本次读结果有效。
	* - `changed`：文件确实变了 → 结果作废，等下一轮对账按新指纹重排。
	* - `gone`：会话/代际文件已消失 → 终态（移除，不再重试）。
	* - `unavailable`：底层受限（IO 错误/超时/满额/中止）→ **不是**「变了」，
	*   走失败冷却改期重试（否则到期失败会每轮被当作「变了」继续、永不进冷却）。
	*/
	async fingerprintVerdict(id, loc) {
		const sessionDir = join(this.root, loc.projectDir, encodeSegment(id));
		const statRun = await this.boundedIo(() => this.fs.stat(join(sessionDir, loc.file)));
		if ("expired" in statRun) return {
			kind: "unavailable",
			message: `fingerprint stat unavailable: io ${statRun.expired}`
		};
		if ("error" in statRun) {
			if (isENOENT(statRun.error)) return { kind: "gone" };
			return {
				kind: "unavailable",
				message: `fingerprint stat failed: ${statRun.error instanceof Error ? statRun.error.message : String(statRun.error)}`
			};
		}
		const namesRun = await this.boundedIo(() => this.fs.readdir(sessionDir));
		if ("expired" in namesRun) return {
			kind: "unavailable",
			message: `fingerprint listing unavailable: io ${namesRun.expired}`
		};
		if ("error" in namesRun) {
			if (isENOENT(namesRun.error)) return { kind: "gone" };
			return {
				kind: "unavailable",
				message: `fingerprint listing failed: ${namesRun.error instanceof Error ? namesRun.error.message : String(namesRun.error)}`
			};
		}
		const chosen = pickGenerationForTracking(namesRun.value.map((entry) => entry.name));
		if (chosen === void 0) return { kind: "gone" };
		if (chosen.name !== loc.file) return { kind: "changed" };
		if (fingerprintOf(statRun.value, chosen.namesKey) !== loc.fingerprint) return { kind: "changed" };
		return {
			kind: "unchanged",
			identity: {
				dev: statRun.value.dev,
				ino: statRun.value.ino,
				mtimeMs: statRun.value.mtimeMs,
				ctimeMs: statRun.value.ctimeMs,
				size: statRun.value.size
			},
			namesKey: chosen.namesKey
		};
	}
	/**
	* 扫描证据与索引位置是否同一实体（I2）：
	* - 文件名/代际/编码必须与索引追踪的文件一致（且是当前代）；
	* - 扫描实际打开的身份必须与**扫描之后**的索引 stat 身份逐字段相等
	*   （dev/ino/mtime/ctime/size）——扫描期间被替换/改写即不相等。
	*/
	scanEvidenceMatchesIndex(scan, loc, verdict) {
		if (verdict.kind !== "unchanged") return false;
		const tracked = parseGenerationFilename(loc.file);
		if (tracked === void 0) return false;
		if (scan.file.name !== loc.file) return false;
		if (scan.file.version !== tracked.version || scan.file.zstd !== tracked.zstd) return false;
		if (scan.file.version !== MAX_KNOWN_SESSION_VERSION) return false;
		const identity = verdict.identity;
		if (scan.identity.dev !== identity.dev) return false;
		if (scan.identity.ino !== identity.ino) return false;
		if (scan.identity.mtimeMs !== identity.mtimeMs) return false;
		if (scan.identity.ctimeMs !== identity.ctimeMs) return false;
		if (scan.identity.size !== identity.size) return false;
		return true;
	}
	/** 记一条可重试失败（改期进冷却）并推进到期堆。 */
	scheduleFailure(id, loc, message) {
		const retryAt = this.now() + this.failureRetryMs;
		this.failures.set(id, {
			sessionId: id,
			projectDir: loc.projectDir,
			file: loc.file,
			fingerprint: loc.fingerprint,
			retryAt,
			message
		});
		this.retryHeapPush(id, retryAt);
		this.recomputeNextRetryAt();
	}
	failureDue(id) {
		const failure = this.failures.get(id);
		return failure !== void 0 && this.now() >= failure.retryAt;
	}
	failureLocation(id) {
		const failure = this.failures.get(id);
		if (failure === void 0) return void 0;
		return {
			projectDir: failure.projectDir,
			file: failure.file,
			fingerprint: failure.fingerprint
		};
	}
	enqueueForClassification(id, loc) {
		this.pendingLocs.set(id, loc);
		if (!this.queued.has(id)) {
			this.queued.add(id);
			this.queueItems.push(id);
			this.queuedCount += 1;
		}
		this.markDirty();
	}
	/** 变更标记：置 dirty、推进变更/判定状态序号（保存回调与稳态缓存据此判定）。 */
	markDirty() {
		this.dirty = true;
		this.mutationSeq += 1;
		this.stateRevision += 1;
	}
	dequeue(id) {
		if (this.queued.delete(id)) this.queuedCount -= 1;
		this.pendingLocs.delete(id);
	}
	/**
	* live 更新分派（I2）：dispose 后拒绝；hydrate 未落定时排队（应用顺序在
	* 持久化载入之后，旧盘判定压不过新 live 事实）；落定后立即应用。
	*/
	dispatchLive(thunk) {
		if (this.disposed) return;
		if (this.persistence === void 0 || this.hydrated) {
			thunk();
			return;
		}
		this.hydrate();
		if (this.hydrated) {
			thunk();
			return;
		}
		this.liveQueue.push(thunk);
	}
	bumpRevision(sessionId) {
		this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1);
	}
	/** live 会话创建/恢复（session/created 载荷）：投影权威判定（零盘读）。 */
	onLiveSession(session) {
		this.membershipStale = true;
		const createdId = liveSessionId(session);
		if (createdId !== void 0) {
			const previous = this.liveInstances.get(createdId);
			if (previous !== void 0 && previous !== session) this.retiredInstances.add(previous);
			this.liveInstances.set(createdId, session);
		}
		this.dispatchLive(() => {
			const facts = liveHeaderOf(session);
			if (facts === void 0) return;
			let finalPreset;
			try {
				finalPreset = this.resolveLivePreset?.(session);
			} catch (error) {
				this.warn(`live 预设投影读取失败（按无权威值处理）: ${error instanceof Error ? error.message : String(error)}`);
				finalPreset = void 0;
			}
			this.applyLiveVerdict(facts.id, facts, finalPreset);
		});
	}
	/**
	* live 会话离开 live store（`session/disposed`；官方契约：会话离开 store
	* 时发出一次，含发布回滚）。
	*
	* 处置（review I6）：撤销该 id 的 **live 权威代际** → 进入**受控冷重判**
	* （交回盘面重扫）或显式 unknown；离开 live 后不再有投影事件维护的旧事实
	* 不能继续授权（`verifyDiskFacts` 对 origin=live 无条件 fresh 的漏洞因此
	* 关闭）。**旧实例的 disposed 不清新实例**：只有与当前认领实例同一对象
	* 的 disposed 才撤销。
	*/
	onLiveSessionDisposed(session) {
		const id = liveSessionId(session);
		if (id === void 0) return;
		if (this.liveInstances.get(id) !== session) return;
		this.liveInstances.delete(id);
		this.dispatchLive(() => {
			this.revokeLiveAuthority(id);
		});
	}
	/**
	* 撤销 live 权威（id 离开 live store）：live 条目作废 → 交回受控冷重判
	* （有位置就重新入队重扫），否则显式 unknown。资格随之失效（待消费授予
	* 撤下；将来重新成立会发新一代）。
	*/
	revokeLiveAuthority(sessionId) {
		const entry = this.entries.get(sessionId);
		this.bumpRevision(sessionId);
		if (entry !== void 0 && entry.origin === "live") {
			this.dropEntry(sessionId);
			this.dequeue(sessionId);
			if (this.failures.delete(sessionId)) this.recomputeNextRetryAt();
			if (entry.projectDir !== "" && entry.file !== "") this.enqueueForClassification(sessionId, {
				projectDir: entry.projectDir,
				file: entry.file,
				fingerprint: entry.fingerprint
			});
			this.markDirty();
		}
		this.syncRouterGrant(sessionId);
		this.scheduleSave();
	}
	/**
	* live 会话事件（session/event 载荷）：`agent-preset/selected` 是权威提交
	* 信号——事件值即最终组合（再选会再发事件），无需投影兜底。
	*/
	onLiveSessionEvent(session, event) {
		const record = event;
		if (record?.type !== "agent-preset/selected") return;
		const eventId = liveSessionId(session);
		if (eventId === void 0) return;
		if (this.retiredInstances.has(session)) return;
		if (!this.liveInstances.has(eventId)) this.liveInstances.set(eventId, session);
		this.membershipStale = true;
		this.dispatchLive(() => {
			const data = record.data;
			if (data === null || typeof data !== "object" || typeof data.agentPreset !== "string") return;
			const facts = liveHeaderOf(session);
			const id = facts?.id ?? eventId;
			const existing = this.entries.get(id);
			const isSeeded = existing?.isSeeded ?? facts?.isSeeded ?? false;
			this.applyLiveVerdict(id, {
				...facts ?? {
					id,
					version: 4,
					createdAt: existing?.createdAt ?? 0,
					isSeeded,
					agentPreset: void 0
				},
				isSeeded
			}, data.agentPreset);
		});
	}
	/** 落一条 live 权威判定（origin=live；清失败/出队；bump revision）。 */
	applyLiveVerdict(sessionId, facts, finalPreset) {
		const { verdict, reason } = classifyLiveComposition(finalPreset, facts.isSeeded, this.routerPreset);
		const existing = this.entries.get(sessionId);
		this.unverified.delete(sessionId);
		this.putEntry(sessionId, {
			sessionId,
			projectDir: existing?.projectDir ?? "",
			file: existing?.file ?? "",
			fingerprint: existing?.fingerprint ?? "",
			verdict,
			createdAt: existing?.createdAt ?? facts.createdAt,
			isSeeded: facts.isSeeded,
			agentPreset: finalPreset === null ? void 0 : finalPreset ?? facts.agentPreset,
			origin: "live",
			reason
		});
		if (this.failures.delete(sessionId)) this.recomputeNextRetryAt();
		this.dequeue(sessionId);
		this.bumpRevision(sessionId);
		this.markDirty();
		this.scheduleSave();
	}
	/**
	* 待消费的 router 资格授予（review I1：可靠记账，不是"看一眼就吞"）。
	*
	* - 只有**当前确实成立**的资格才在待消费面：载入缓存未核指纹
	*   （unverified → verdictOf=pending）、判定为 unknown/nonrouter 的会话
	*   **不在**待消费面——不会因为"曾经是 router"就被提前消费掉、丢掉未来
	*   资格。
	* - 授予**不被读取即消费**：只有消费方 ack（`ackRouterGrant`）才移除。
	*   消费方因此可以安全地"没处理完就跳过"（延期/退避），候选不会永久漏。
	* - 资格"不再成立 → 又成立"发**新一代**授予（代数 +1）：两个轮询之间
	*   router→other→router 的翻面不会被旧基线吞掉。
	* - 稳态：待消费面为空 → 本方法 O(1)，不做全库重建。
	*
	* @param limit - 本次最多取几条（消费方的单轮预算）。
	*/
	unclaimedRouterGrants(limit) {
		const out = [];
		if (limit <= 0) return out;
		for (const [sessionId, generation] of this.pendingGrants) {
			if (out.length >= limit) break;
			out.push({
				sessionId,
				generation
			});
		}
		return out;
	}
	/**
	* **领取**未领取的资格授予（review I7 round 2）：把至多 `limit` 条从未领取
	* 的授予移入「已领取」面并返回。
	*
	* 为什么要有"领取"这一步（与 round 1 的"读 + skip 集合"不同）：消费方需要
	* **把"新授予"和"自己正在退避重试的旧授予"分开枚举**。round 1 用 skip 集合
	* 跳过已延期项，但 skip 项不消耗访问预算 → 每轮仍要从头遍历全部积压
	* （N 个延期项 → 每轮 O(N) 检查/分配）。拆成两个面之后：
	* - 未领取面只装**新**授予 → 枚举到 `limit` 条即止（O(limit)）；
	* - 已领取面装消费方**正在自行排期重试**的授予 → 它们由消费方的到期调度
	*   驱动，不再参与每轮枚举。
	*
	* 记账不变：ack 前授予不丢；资格撤销（不再成立）时两侧都撤下；重新成立发
	* **新一代**授予（回到未领取面，不会被旧的延期项吞掉）。
	*/
	claimRouterGrants(limit) {
		const out = [];
		if (limit <= 0) return out;
		for (const [sessionId, generation] of this.pendingGrants) {
			if (out.length >= limit) break;
			this.counters.grantVisits += 1;
			this.pendingGrants.delete(sessionId);
			this.claimedGrants.set(sessionId, generation);
			out.push({
				sessionId,
				generation
			});
		}
		return out;
	}
	/** 某 id 当前的资格代数（已领取或未领取都算；没有授予则 undefined）。 */
	routerGrantGeneration(sessionId) {
		return this.claimedGrants.get(sessionId) ?? this.pendingGrants.get(sessionId);
	}
	/** 未领取授予的条数（O(1)；诊断"是否还有新工作"用）。 */
	unclaimedRouterGrantCount() {
		return this.pendingGrants.size;
	}
	/**
	* **交还**一条已领取的授予（回到未领取面）：消费方在异常路径上没能给这条
	* 授予安排所有者（deferred/pending）时用它兜底——交还后下一轮会重新领取，
	* 绝不留下"已领取但无主"的孤儿（review N1）。
	*/
	releaseRouterGrant(sessionId, generation) {
		if (this.claimedGrants.get(sessionId) !== generation) return;
		this.claimedGrants.delete(sessionId);
		this.pendingGrants.set(sessionId, generation);
	}
	/**
	* 消费方 ack（记账点）：代数不符即忽略——新一代资格未被消费，旧的一代
	* 不能把新一代标记成已消费。
	*/
	ackRouterGrant(sessionId, generation) {
		if (this.claimedGrants.get(sessionId) === generation) {
			this.claimedGrants.delete(sessionId);
			return;
		}
		if (this.pendingGrants.get(sessionId) === generation) this.pendingGrants.delete(sessionId);
	}
	/**
	* 资格同步（唯一入口）：某 id 的资格当前是否成立 = 条目判定为 router
	* **且**已核验（不在 unverified 集里——载入缓存未核指纹前不授权）。
	* 成立且此前不成立 → 发新一代授予（回未领取面）；此前成立现在不成立 →
	* 撤下两侧的授予。
	*/
	syncRouterGrant(sessionId) {
		const entry = this.entries.get(sessionId);
		const eligible = entry !== void 0 && entry.verdict === "router" && !this.unverified.has(sessionId);
		const state = this.grantState.get(sessionId);
		if (eligible) {
			if (state === void 0 || !state.eligible) {
				const generation = ++this.eligibilitySeq;
				this.grantState.set(sessionId, {
					generation,
					eligible: true
				});
				this.pendingGrants.set(sessionId, generation);
			}
			return;
		}
		if (state !== void 0 && state.eligible) {
			state.eligible = false;
			this.pendingGrants.delete(sessionId);
			this.claimedGrants.delete(sessionId);
		}
	}
	/**
	* 落一条判定（唯一写入口）：判定/来源变化时推进生命周期代际（授权屏障），
	* 并同步 router 资格。
	*/
	putEntry(sessionId, entry) {
		const previous = this.entries.get(sessionId);
		this.entries.set(sessionId, entry);
		if (previous === void 0 || previous.verdict !== entry.verdict || previous.origin !== entry.origin) this.bumpAuthority(sessionId);
		this.syncRouterGrant(sessionId);
	}
	/** 移除一条判定（同步资格：资格不再成立 → 撤下待消费授予）。 */
	dropEntry(sessionId) {
		const previous = this.entries.get(sessionId);
		this.entries.delete(sessionId);
		this.unverified.delete(sessionId);
		if (previous !== void 0) this.bumpAuthority(sessionId);
		this.syncRouterGrant(sessionId);
	}
	/**
	* 彻底遗忘一个已确认消失的会话的辅助记账（审查：revisions/authorityTokens/
	* grantState 按 id 无限累积，长运行宿主慢泄漏）。只在「对账确认磁盘无此会话
	* 且无 live 实例」处调用——该点与 advance/verify 同一串行链，没有在途计划持有
	* 旧 token；重新出现会经 putEntry 从全局单调代际重新发授予，不与旧计划撞代。
	* 不在 dropEntry 内做：dropEntry 也用于「指纹变了→重判」，那时不能清记账。
	*/
	forgetSessionAuxiliaries(sessionId) {
		if (this.liveInstances.has(sessionId)) return;
		this.revisions.delete(sessionId);
		this.authorityTokens.delete(sessionId);
		this.grantState.delete(sessionId);
		this.pendingGrants.delete(sessionId);
		this.claimedGrants.delete(sessionId);
	}
	/** 生命周期代际 +1（任何影响授权的事实变化）。 */
	bumpAuthority(sessionId) {
		this.authorityTokens.set(sessionId, (this.authorityTokens.get(sessionId) ?? 0) + 1);
	}
	/** 判定状态版本号（稳态缓存键；每次判定/队列/失败变化 +1）。 */
	revision() {
		return this.stateRevision;
	}
	/**
	* I1 r3：索引自身 fs 元数据操作（枚举/指纹复核）走与头读共享的槽位 +
	* deadline + 真实 AbortSignal——挂起/满额都快速返回，dispose 即刻唤醒；
	* 槽位由底层操作真正 settle 时释放。
	*/
	async boundedIo(op) {
		if (this.disposed) return { expired: "abort" };
		if (!this.ioBudget.tryAcquire()) return { expired: "busy" };
		const signal = this.abortController.signal;
		return new Promise((resolve) => {
			let settled = false;
			let cancelTimer = () => void 0;
			let detach;
			const finish = (result) => {
				if (settled) return;
				settled = true;
				cancelTimer();
				detach?.();
				resolve(result);
			};
			cancelTimer = this.scheduleFn(READ_DEADLINE_MS, () => finish({ expired: signal.aborted ? "abort" : "deadline" }));
			const onAbort = () => finish({ expired: "abort" });
			signal.addEventListener("abort", onAbort);
			detach = () => signal.removeEventListener("abort", onAbort);
			this.ioBudget.attachRelease(op().then((value) => finish({ value }), (error) => finish({ error })));
		});
	}
	/** 是否还有待分类积压（O(1)：游标计数 + nextRetryAt 到期判定，I8 r2）。 */
	hasBacklog() {
		return this.queuedCount > 0 || this.now() >= this.nextRetryAt;
	}
	/** 宿主成员快照（轮询只读快照，不打宿主面；I8 r2）。 */
	workspaces() {
		return this.membershipSnapshot;
	}
	/**
	* 成员定位（增量缓存）：某会话当前在哪个工作区、是否已被宿主归档。
	* O(1)——收编侧据此定位目标工作区，不必每轮遍历宿主全部工作区/会话
	* （review I7）。缓存随成员快照刷新（低频对账 / 事件失效）。
	*/
	locateMember(sessionId) {
		const workspaceId = this.membershipIndex.get(sessionId);
		if (workspaceId === void 0) return void 0;
		return {
			workspaceId,
			archived: this.archivedSnapshot.has(sessionId)
		};
	}
	/** 生命周期代际（授权屏障）：await 前后比对同一代数识别过期计划。 */
	authorityToken(sessionId) {
		return this.authorityTokens.get(sessionId) ?? 0;
	}
	/** 宿主归档集快照（同上）。 */
	archivedSnapshotIds() {
		return this.archivedSnapshot;
	}
	/** 同代快照三元组：workspaces/archived 与产出它们的 revision 同读（R2-A）。 */
	membershipState() {
		return {
			workspaces: this.membershipSnapshot,
			archived: this.archivedSnapshot,
			revision: this.stateRevision
		};
	}
	/** 副作用前的权威核验：绕过失效标记强制重读宿主面（R2-A；仅权威变动轮调用）。 */
	forceRefreshMembership() {
		this.refreshMembership();
	}
	/**
	* 成员快照版本号（只在成员/归档内容变化时前进）——消费方据此缓存成员名单，
	* 避免每轮重建全成员名单（分批收敛时的平方成本）。
	*/
	membershipRevision() {
		return this.membershipRevisionCounter;
	}
	/**
	* 针对性权威核验（R2-A r4）：只回答「被点名的目标现在还是 workspace 成员
	* 吗/已被宿主归档吗」。**不做全成员 join/签名重组**——只读被问到的
	* workspace 的成员数组与归档集（O(被问到的成员数 + 归档数)），因此可以
	* 在稳态轮询里每轮做一次轻量核验，而不把全成员串行化。
	*/
	verifyTargets(requests) {
		const facts = /* @__PURE__ */ new Map();
		if (this.membership === void 0) return facts;
		const archived = this.membership.archivedIds?.() ?? [];
		const archivedSet = new Set(archived);
		let listed;
		for (const request of requests) {
			let workspace = this.membership.get?.(request.workspaceId);
			if (workspace === void 0) {
				listed ??= this.membership.list();
				workspace = listed.find((entry) => entry.id === request.workspaceId);
			}
			const memberSet = new Set(workspace?.sessionIds ?? []);
			for (const sessionId of request.sessionIds) facts.set(sessionId, {
				member: memberSet.has(sessionId),
				archived: archivedSet.has(sessionId)
			});
		}
		return facts;
	}
	/** 快照失效（live 事件置位）后由消费方触发一次刷新；返回是否发生了刷新。 */
	refreshMembershipIfStale() {
		if (!this.membershipStale || this.membership === void 0) return false;
		this.refreshMembership();
		return true;
	}
	/** 刷新成员/归档快照；内容变化时推进判定版本号（dedup 稳态缓存随之失效）。 */
	refreshMembership() {
		if (this.membership === void 0) return;
		const listed = this.membership.list();
		const archived = this.membership.archivedIds?.() ?? [];
		const membershipChanged = this.membershipSnapshot.length !== listed.length || listed.some((ws, i) => {
			const prev = this.membershipSnapshot[i];
			return prev === void 0 || prev.id !== ws.id || (prev.sessionIds ?? []).join(",") !== (ws.sessionIds ?? []).join(",");
		});
		const archivedChanged = this.archivedSnapshot.size !== archived.length || archived.some((id) => !this.archivedSnapshot.has(id));
		this.membershipSnapshot = listed;
		this.archivedSnapshot = new Set(archived);
		const locations = /* @__PURE__ */ new Map();
		for (const workspace of listed) for (const sessionId of workspace.sessionIds ?? []) if (!locations.has(sessionId)) locations.set(sessionId, workspace.id);
		this.membershipIndex = locations;
		this.membershipStale = false;
		if (membershipChanged || archivedChanged) {
			this.membershipRevisionCounter += 1;
			this.markDirty();
		}
	}
	/** 查判定：classified / pending（未判定或未知存在性）/ failed（冷却中）。 */
	verdictOf(sessionId) {
		const entry = this.entries.get(sessionId);
		if (entry !== void 0 && this.unverified.has(sessionId)) return { status: "pending" };
		if (entry !== void 0) {
			const lookup = {
				status: "classified",
				verdict: entry.verdict
			};
			if (entry.createdAt !== void 0) lookup.createdAt = entry.createdAt;
			if (entry.isSeeded !== void 0) lookup.isSeeded = entry.isSeeded;
			if (entry.agentPreset !== void 0) lookup.agentPreset = entry.agentPreset;
			if (entry.reason !== void 0) lookup.reason = entry.reason;
			lookup.origin = entry.origin;
			if (entry.evidence !== void 0) lookup.evidence = entry.evidence;
			return lookup;
		}
		const failure = this.failures.get(sessionId);
		if (failure !== void 0) return {
			status: "failed",
			retryAt: failure.retryAt
		};
		return { status: "pending" };
	}
	/**
	* cold verdict v2：副作用/暴露前的**定点磁盘事实核验**。被点名的 disk 判定
	* 所依据的文件指纹是否仍然当前：
	* - fresh：指纹一致，判定仍可信；
	* - changed：文件/代际变了 → 作废旧判定并按新位置重新入队（受控重扫）；
	* - missing：文件消失 → 移除条目（终态）；
	* - untrusted：IO 错误/超时/满额/在途 live 事实（revision 前进）→ **保留旧
	*   条目但不得授权动作**（fail-closed，不把核验失败当 fresh）。
	* live-origin 判定不依赖文件指纹，直接 fresh。只核验被点名者，绝不整库扫描。
	*/
	async verifyDiskFacts(sessionIds) {
		const results = /* @__PURE__ */ new Map();
		for (const id of sessionIds) results.set(id, {
			ok: false,
			kind: "untrusted"
		});
		await this.hydrate();
		if (this.disposed) return results;
		const work = async () => {
			for (const id of sessionIds) {
				const entry = this.entries.get(id);
				if (entry === void 0) {
					results.set(id, {
						ok: false,
						kind: "missing"
					});
					continue;
				}
				if (entry.origin === "live") {
					results.set(id, { ok: true });
					continue;
				}
				const revisionBefore = this.revisions.get(id) ?? 0;
				const sessionDir = join(this.root, entry.projectDir, encodeSegment(id));
				const statRun = await this.boundedIo(() => this.fs.stat(join(sessionDir, entry.file)));
				if ((this.revisions.get(id) ?? 0) !== revisionBefore || this.disposed) {
					results.set(id, {
						ok: false,
						kind: "untrusted"
					});
					continue;
				}
				if ("expired" in statRun) {
					results.set(id, {
						ok: false,
						kind: "untrusted"
					});
					continue;
				}
				if ("error" in statRun) {
					if (isENOENT(statRun.error)) {
						this.dropEntry(id);
						this.dequeue(id);
						if (this.failures.delete(id)) this.recomputeNextRetryAt();
						this.markDirty();
						results.set(id, {
							ok: false,
							kind: "missing"
						});
						continue;
					}
					results.set(id, {
						ok: false,
						kind: "untrusted"
					});
					continue;
				}
				const namesRun = await this.boundedIo(() => this.fs.readdir(sessionDir));
				if ((this.revisions.get(id) ?? 0) !== revisionBefore || this.disposed) {
					results.set(id, {
						ok: false,
						kind: "untrusted"
					});
					continue;
				}
				if ("expired" in namesRun || "error" in namesRun) {
					results.set(id, {
						ok: false,
						kind: "untrusted"
					});
					continue;
				}
				const chosen = pickGenerationForTracking(namesRun.value.map((listed) => listed.name));
				const currentFingerprint = chosen === void 0 ? void 0 : chosen.name === entry.file ? fingerprintOf(statRun.value, chosen.namesKey) : void 0;
				if (currentFingerprint === void 0 || currentFingerprint !== entry.fingerprint) {
					this.dropEntry(id);
					if (chosen !== void 0) this.enqueueForClassification(id, {
						projectDir: entry.projectDir,
						file: chosen.name,
						fingerprint: fingerprintOf(statRun.value, chosen.namesKey)
					});
					if (this.failures.delete(id)) this.recomputeNextRetryAt();
					this.markDirty();
					results.set(id, {
						ok: false,
						kind: "changed"
					});
					continue;
				}
				results.set(id, { ok: true });
			}
		};
		await this.enqueue(work).catch(() => void 0);
		return results;
	}
	/**
	* 背景推进 + 低频对账（不依赖 UI 轮询）：初始对账一次，之后定时驱动；
	* 队列非空时按 backgroundIntervalMs 有界推进。返回停止函数。
	*/
	start() {
		if (this.started || this.disposed) return () => void 0;
		this.started = true;
		this.reconcile().catch((error) => {
			this.warn(`候选索引初始对账失败（下轮定时重试）: ${error instanceof Error ? error.message : String(error)}`);
		});
		let stopReconcile = () => void 0;
		const tickReconcile = () => {
			if (this.disposed) return;
			stopReconcile = this.scheduleFn(this.reconcileIntervalMs, tickReconcile);
			this.reconcile().catch((error) => {
				this.warn(`候选索引对账失败（忽略）: ${error instanceof Error ? error.message : String(error)}`);
			});
		};
		stopReconcile = this.scheduleFn(this.reconcileIntervalMs, tickReconcile);
		let stopAdvance = () => void 0;
		const tickAdvance = () => {
			if (this.disposed) return;
			stopAdvance = this.scheduleFn(this.backgroundIntervalMs, tickAdvance);
			if (this.hasBacklog()) this.advance().catch((error) => {
				this.warn(`候选索引背景推进失败（忽略）: ${error instanceof Error ? error.message : String(error)}`);
			});
		};
		stopAdvance = this.scheduleFn(this.backgroundIntervalMs, tickAdvance);
		this.stopBackground = () => {
			stopReconcile();
			stopAdvance();
			this.started = false;
		};
		return this.stopBackground;
	}
	/** 诊断口径（计数为主，不含会话 id/路径等私有内容）。 */
	diagnostics() {
		const breakdown = {
			total: this.entries.size,
			router: 0,
			nonrouter: 0,
			unknown: 0,
			live: 0
		};
		const byEvidence = {
			"stable-eof": 0,
			"header-seeded": 0,
			live: 0,
			none: 0
		};
		for (const entry of this.entries.values()) {
			breakdown[entry.verdict] += 1;
			if (entry.origin === "live") {
				breakdown.live += 1;
				byEvidence.live += 1;
			} else if (entry.evidence === "stable-eof") byEvidence["stable-eof"] += 1;
			else if (entry.verdict === "nonrouter" && entry.isSeeded === true) byEvidence["header-seeded"] += 1;
			else byEvidence.none += 1;
		}
		return {
			root: this.root,
			preset: this.routerPreset,
			queueLength: this.queuedCount,
			failures: this.failures.size,
			bootstrap: {
				initialDone: this.initialDone,
				...this.lastReconcileAt !== void 0 ? { lastReconcileAt: this.lastReconcileAt } : {},
				...this.lastReconcileError !== void 0 ? { lastReconcileError: this.lastReconcileError } : {}
			},
			entries: {
				...breakdown,
				byEvidence
			},
			header: {
				attempts: this.counters.headerAttempts,
				errors: this.counters.headerErrors,
				cacheReused: this.counters.cacheReused,
				bytesCompressed: this.counters.bytesCompressed,
				bytesDecompressed: this.counters.bytesDecompressed
			},
			scan: {
				attempts: this.counters.scanAttempts,
				finals: this.counters.scanFinals,
				caps: this.counters.scanCaps,
				unstable: this.counters.scanUnstable
			},
			concurrency: {
				inflightAdvance: this.inflightAdvance !== void 0,
				inflightReconcile: this.inflightReconcile !== void 0,
				reconcileRuns: this.counters.reconcileRuns,
				advanceRuns: this.counters.advanceRuns
			},
			degraded: { unsupportedCodec: [...this.entries.values()].some((entry) => entry.reason?.startsWith("unsupported") === true || entry.reason?.includes("scan unsupported") === true) },
			grant: {
				pending: this.pendingGrants.size,
				claimed: this.claimedGrants.size,
				eligible: [...this.grantState.values()].filter((state) => state.eligible).length,
				visits: this.counters.grantVisits
			}
		};
	}
	/** 安全处置：停定时、中断在途读取、等在途工作（含独立 hydrate）落定、冲刷保存。 */
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.stopBackground?.();
		if (this.saveTimerCancel !== void 0) {
			this.saveTimerCancel();
			this.saveTimerCancel = void 0;
		}
		this.abortController.abort();
		await this.inflightReconcile?.catch(() => void 0);
		await this.inflightAdvance?.catch(() => void 0);
		await this.chain.catch(() => void 0);
		await this.hydratePromise?.catch(() => void 0);
		await this.saveChain.catch(() => void 0);
		if (this.dirty) await this.pumpSave();
	}
	scheduleSave() {
		if (!this.dirty || this.persistence === void 0 || this.disposed) return;
		if (this.saveRunning) return;
		if (this.saveTimerCancel !== void 0) return;
		const now = this.now();
		if (this.saveDueAt === void 0) this.saveDueAt = now + SAVE_DEBOUNCE_MS;
		this.saveTimerCancel = this.scheduleFn(Math.max(0, this.saveDueAt - now), () => {
			this.saveTimerCancel = void 0;
			this.pumpSave();
		});
	}
	/**
	* 保存 worker（I6 r2）：单 worker 串行；每轮取**最新**快照——在途期间
	* 的任何 dirty 都合并进唯一一笔后续保存，不排队完整快照闭包。失败保留
	* dirty 并只排一个重试计时；dispose 后失败不再重排（I7 r2）。
	*/
	async pumpSave() {
		if (this.saveRunning || this.persistence === void 0) return;
		this.saveRunning = true;
		this.saveChain = (async () => {
			try {
				while (this.dirty) {
					const state = this.snapshotState();
					const seqAtSave = this.mutationSeq;
					try {
						await this.persistence.save(state);
						if (this.mutationSeq === seqAtSave) {
							this.dirty = false;
							this.saveDueAt = void 0;
						}
					} catch (error) {
						this.warn(`候选索引保存失败（保留待写，窗口后重试）: ${error instanceof Error ? error.message : String(error)}`);
						if (this.disposed) break;
						this.saveDueAt = this.now() + SAVE_DEBOUNCE_MS;
						if (this.saveTimerCancel !== void 0) this.saveTimerCancel();
						this.saveTimerCancel = this.scheduleFn(SAVE_DEBOUNCE_MS, () => {
							this.saveTimerCancel = void 0;
							this.pumpSave();
						});
						break;
					}
				}
			} finally {
				this.saveRunning = false;
			}
		})();
		return this.saveChain;
	}
	snapshotState() {
		return {
			version: 2,
			root: this.root,
			preset: this.routerPreset,
			savedAt: this.now(),
			entries: [...this.entries.values()].map((entry) => ({ ...entry })),
			failures: [...this.failures.values()].map((failure) => ({ ...failure }))
		};
	}
};
function isValidStateFile(value, root, preset) {
	if (typeof value !== "object" || value === null) return false;
	const record = value;
	return (record["version"] === 1 || record["version"] === 2) && record["root"] === root && record["preset"] === preset && Array.isArray(record["entries"]) && Array.isArray(record["failures"]);
}
/** 缓存路径段必须是规范单段：非空、无分隔符、不是 . / ..、无 NUL（I10）。 */
function isSafeSegment(value) {
	if (typeof value !== "string" || value.length === 0) return false;
	if (value === "." || value === "..") return false;
	if (value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
	return true;
}
function isValidEntry(value, routerPreset) {
	if (typeof value !== "object" || value === null) return false;
	const record = value;
	if (typeof record["sessionId"] !== "string" || record["sessionId"].length === 0) return false;
	if (record["verdict"] !== "router" && record["verdict"] !== "nonrouter" && record["verdict"] !== "unknown") return false;
	if (record["origin"] !== "disk" && record["origin"] !== "live") return false;
	if (!isSafeSegment(record["projectDir"])) return false;
	if (typeof record["file"] !== "string" || parseGenerationFilename(record["file"]) === void 0) return false;
	if (typeof record["fingerprint"] !== "string") return false;
	if (record["createdAt"] !== void 0 && !(typeof record["createdAt"] === "number" && Number.isSafeInteger(record["createdAt"]) && record["createdAt"] >= 0)) return false;
	if (record["isSeeded"] !== void 0 && typeof record["isSeeded"] !== "boolean") return false;
	if (record["agentPreset"] !== void 0 && typeof record["agentPreset"] !== "string") return false;
	if (record["reason"] !== void 0 && typeof record["reason"] !== "string") return false;
	if (record["evidence"] !== void 0 && record["evidence"] !== "stable-eof") return false;
	if (record["origin"] === "live" && record["evidence"] !== void 0) return false;
	if (record["origin"] === "disk" && record["verdict"] === "router" && record["evidence"] !== "stable-eof") return false;
	if (record["origin"] === "disk" && record["verdict"] === "nonrouter" && record["isSeeded"] !== true && record["evidence"] !== "stable-eof") return false;
	if (record["evidence"] === "stable-eof") {
		if (record["origin"] !== "disk") return false;
		const generation = parseGenerationFilename(record["file"]);
		if (generation === void 0 || generation.version !== MAX_KNOWN_SESSION_VERSION) return false;
		if (record["isSeeded"] === true) return false;
		if (typeof record["createdAt"] !== "number") return false;
		const preset = record["agentPreset"];
		if (record["verdict"] === "router") {
			if (preset !== routerPreset) return false;
		} else if (preset === routerPreset) return false;
		if (!fingerprintDescribesFile(record["fingerprint"], record["file"])) return false;
	}
	return true;
}
/**
* 指纹是否描述了该文件（fingerprint 形如
* `dev:ino:mtimeMs:ctimeMs:size:<generation 名集合>`；名集合必须含该文件）。
*/
function fingerprintDescribesFile(fingerprint, file) {
	const parts = fingerprint.split(":");
	if (parts.length !== 6) return false;
	return parts[5].split("|").includes(file);
}
function isValidFailure(value) {
	if (typeof value !== "object" || value === null) return false;
	const record = value;
	if (typeof record["sessionId"] !== "string" || record["sessionId"].length === 0) return false;
	if (!isSafeSegment(record["projectDir"])) return false;
	if (typeof record["file"] !== "string" || parseGenerationFilename(record["file"]) === void 0) return false;
	if (typeof record["fingerprint"] !== "string") return false;
	if (typeof record["retryAt"] !== "number" || !Number.isFinite(record["retryAt"])) return false;
	if (record["message"] !== void 0 && typeof record["message"] !== "string") return false;
	return true;
}
/** 目录名清单 → 追踪用 generation 文件（见上方 pickGenerationForTracking；此处为兼容旧引用保留别名）。 */

//#endregion
//#region src/host/context/compaction-driver.ts
var CompactionDriver = class {
	deps;
	/** 每会话上次压缩终点（下一次区域起点 = 检查点 + 1；初始 -1 → 从 0 起）。 */
	checkpoints = /* @__PURE__ */ new Map();
	pending = /* @__PURE__ */ new Set();
	compacting = /* @__PURE__ */ new Set();
	constructor(deps) {
		this.deps = deps;
	}
	/** 成功转交（派发/补充重投）后调用：给目标会话打标记。 */
	onDispatched(sessionId) {
		this.pending.add(sessionId);
	}
	/** 压缩是否待办（测试与观测口）。 */
	isPending(sessionId) {
		return this.pending.has(sessionId);
	}
	/** 某会话的当前检查点（观测口）。 */
	checkpointOf(sessionId) {
		return this.checkpoints.get(sessionId) ?? -1;
	}
	/** 会话空闲：有 pending 标记、无排队消息才尝试压缩。 */
	async onIdle(sessionId, signal) {
		if (!this.pending.has(sessionId)) return "no-op";
		if (this.compacting.has(sessionId)) return "no-op";
		if (this.deps.queueEmpty !== void 0) try {
			if (!await this.deps.queueEmpty(sessionId)) return "skipped";
		} catch {
			return "skipped";
		}
		const agent = this.deps.getAgent(sessionId);
		if (agent === void 0) return "skipped";
		if (agent.status !== void 0 && agent.status !== "idle") return "skipped";
		this.compacting.add(sessionId);
		try {
			const lastUserSeq = await this.deps.lastUserMessageSeq(sessionId);
			if (lastUserSeq === null) return "skipped";
			const start = this.checkpointOf(sessionId) + 1;
			const end = lastUserSeq - 1;
			if (end < start) return "skipped";
			const session = agent.session;
			if (!await this.deps.balancedBefore(session, start)) return "skipped";
			if (!await this.deps.balancedAfter(session, end)) return "skipped";
			const endSeq = (await this.deps.compactRegion(start, end, agent, signal))?.endSeq;
			this.checkpoints.set(sessionId, typeof endSeq === "number" ? endSeq : end);
			this.pending.delete(sessionId);
			return "compacted";
		} catch {
			return "skipped";
		} finally {
			this.compacting.delete(sessionId);
		}
	}
};

//#endregion
//#region src/host/routes.ts
const ROUTER_STATE_PATH = "/router/state";
const ROUTER_SESSION_PATH = "/router/router-session";
const ROUTER_ANSWER_PATH = "/router/answer";
const ROUTER_TABS_CLOSE_PATH = "/router/tabs/close";
/** 入口去重指令的消费回执（v1.1 Task C4）。 */
/** Worker 类型管理（v1.1 Task C3，规格 §5/§6）：同路径 GET 列表 / POST 新建 / DELETE 删。 */
const WORKER_TYPES_PATH = "/router/worker-types";
const WORKER_TYPES_UPDATE_PATH = "/router/worker-types/update";
const WORKER_TYPES_ENABLED_PATH = "/router/worker-types/enabled";
/** Router 默认值（规格 §6）：GET 读 / POST 写。 */
const ROUTER_NOTIFICATIONS_ACK_PATH = "/router/notifications/ack";
const ROUTER_DEFAULTS_PATH = "/router/defaults";
/** worker 派生模式（v1.3 C2，规格 §1）：GET 读 / POST 写（volatile，即时生效）。 */
const ROUTER_SPAWN_MODE_PATH = "/router/spawn-mode";
/** 会话级 Router 系统提示词（v1.1 C5，规格 §7）：GET 读 / PUT 写（空串=清除回落默认）。 */
const ROUTER_PROMPT_PATH = "/router/prompt";
/** 用户发起的任务控制（v1.2 Task B4）：镜像 control_task + 用户专属 redispatch。 */
const ROUTER_TASKS_CONTROL_PATH = "/router/tasks/control";
/** 用户解除派发冻结（v1.2 Task B4；冻结的解除通道）。 */
const ROUTER_BREAKER_UNFREEZE_PATH = "/router/breaker/unfreeze";
/** 紧急暂停（v1.2 Task B4）：冻结 + 逐会话中断 + 异常通知。 */
const ROUTER_EMERGENCY_PAUSE_PATH = "/router/emergency-pause";
/** 轻量诊断（v1.4）：索引 + 收编计数口径，无私有内容。 */
const ROUTER_HEALTH_PATH = "/router/health";
/** 域错误码 → HTTP 状态。 */
function errorStatus(error) {
	if (error instanceof SyntaxError) return 400;
	switch (error instanceof LedgerError ? error.code : void 0) {
		case "already-answered":
		case "stale-version":
		case "illegal-transition":
		case "dependency-cycle":
		case "doc-exists":
		case "template-exists":
		case "builtin-protected": return 409;
		case "card-not-found":
		case "task-not-found":
		case "question-not-found":
		case "doc-not-found":
		case "template-not-found": return 404;
		case "role-forbidden":
		case "not-task-owner":
		case "caller-unresolved": return 403;
		case "dispatch-frozen":
		case "supervisor-failure-budget":
		case "per-turn-task-budget": return 409;
		case "unknown-tool":
		case "bad-request":
		case "invalid-input": return 400;
		default: return 500;
	}
}
/** JSON 应答：no-store + 显式长度（照 auto-resume / chat-power 路由的写法）。 */
function respondJson(response, status, body) {
	response.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	response.end(body);
}
/** 读请求体（上限 1 MB，超出 413）。 */
const BODY_LIMIT = 1e6;
function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("body too large"));
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(chunks.map((chunk) => chunk.toString("utf8")).join("")));
		request.on("error", reject);
	});
}
/**
* 读并解析 JSON 请求体为对象。JSON.parse("null")/数字/字符串/数组都合法 JSON
* 但不是对象，后续 body.xxx 取值会在 null 上抛 TypeError 落 500——统一在边界
* 拒成 400，避免把客户端坏输入当成内部错误（也避免 500 泄露堆栈/路径）。
*/
async function readJsonBody(request) {
	const parsed = JSON.parse(await readBody(request));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new LedgerError("bad-request", "请求体须为 JSON 对象");
	return parsed;
}
/**
* 挂 exact 路由。webServer/connection 缺席时不挂（观测面不挡装载）；
* 每条路由先过 connection.admit 同一登录准入，再校验方法（一条路径可声明
* 多个合法方法，如 worker-types 的 GET/POST/DELETE），再进逻辑。
*/
function registerRouterRoutes(ctx, deps) {
	if (ctx.webServer === void 0 || ctx.connection === void 0) return;
	const handle = (path, methods, logic) => {
		const allow = methods.join(", ");
		ctx.effect(() => ctx.webServer?.register({
			kind: "exact",
			path,
			async handler(request, response) {
				const admission = ctx.connection?.admit(request);
				if (admission !== void 0 && "rejection" in admission) {
					response.writeHead(admission.rejection);
					response.end(admission.rejection === 401 ? "unauthorized" : "forbidden");
					return;
				}
				if (request.method === void 0 || !methods.includes(request.method)) {
					response.writeHead(405, {
						"content-type": "text/plain; charset=utf-8",
						allow
					});
					response.end("method not allowed");
					return;
				}
				try {
					const { status, body } = await logic(request);
					respondJson(response, status, body);
				} catch (error) {
					const status = errorStatus(error);
					const message = status >= 500 ? "internal error" : error instanceof Error ? error.message : String(error);
					respondJson(response, status, JSON.stringify({ error: message }));
				}
			}
		}), `dsh-router: ${allow} ${path}`);
	};
	handle(ROUTER_STATE_PATH, ["GET"], async (request) => {
		const workspaceId = new URL(request.url ?? "/", "http://localhost").searchParams.get("workspaceId") ?? void 0;
		const state = await deps.getState(workspaceId);
		return {
			status: 200,
			body: JSON.stringify(state)
		};
	});
	handle(ROUTER_SESSION_PATH, ["POST"], async (request) => {
		const body = await readJsonBody(request);
		if (typeof body.workspaceId !== "string" || body.workspaceId === "") throw new LedgerError("bad-request", "workspaceId 必填");
		const name$1 = typeof body.name === "string" && body.name !== "" ? body.name : void 0;
		const created = await deps.createRouterSession(body.workspaceId, name$1);
		return {
			status: 200,
			body: JSON.stringify({ sessionId: created.sessionId })
		};
	});
	handle(ROUTER_ANSWER_PATH, ["POST"], async (request) => {
		const body = await readJsonBody(request);
		if (typeof body.questionId !== "string" || !Array.isArray(body.answers)) throw new LedgerError("bad-request", "questionId 与 answers 必填");
		const answers = body.answers.map((item) => {
			if (item === null || typeof item !== "object") throw new LedgerError("bad-request", "answers 条目须为对象");
			const record = item;
			if (typeof record.id !== "string" || !Array.isArray(record.selected) || !record.selected.every((s) => typeof s === "string")) throw new LedgerError("bad-request", "answers 条目须含 id 与字符串数组 selected");
			if (record.custom !== void 0 && typeof record.custom !== "string") throw new LedgerError("bad-request", "answers 条目的 custom 须为字符串");
			return record.custom === void 0 ? {
				id: record.id,
				selected: record.selected
			} : {
				id: record.id,
				selected: record.selected,
				custom: record.custom
			};
		});
		await deps.answerQuestion(body.questionId, answers);
		return {
			status: 200,
			body: JSON.stringify({ ok: true })
		};
	});
	handle(ROUTER_TABS_CLOSE_PATH, ["POST"], async (request) => {
		const body = await readJsonBody(request);
		if (typeof body.workspaceId !== "string" || typeof body.sessionId !== "string") throw new LedgerError("bad-request", "workspaceId 与 sessionId 必填");
		await deps.closeTab(body.workspaceId, body.sessionId);
		return {
			status: 200,
			body: JSON.stringify({ ok: true })
		};
	});
	handle(WORKER_TYPES_PATH, [
		"GET",
		"POST",
		"DELETE"
	], async (request) => {
		if (request.method === "GET") return {
			status: 200,
			body: JSON.stringify(await deps.listWorkerTypes())
		};
		if (request.method === "POST") {
			const input = sanitizeCreateInput(await readJsonBody(request));
			const created = await deps.createWorkerType(input);
			return {
				status: 200,
				body: JSON.stringify(created)
			};
		}
		const templateId = new URL(request.url ?? "/", "http://localhost").searchParams.get("templateId") ?? "";
		if (templateId === "") throw new LedgerError("bad-request", "templateId 查询参数必填");
		await deps.removeWorkerType(templateId);
		return {
			status: 200,
			body: JSON.stringify({ ok: true })
		};
	});
	handle(WORKER_TYPES_UPDATE_PATH, ["POST"], async (request) => {
		const body = await readJsonBody(request);
		if (typeof body.templateId !== "string" || body.templateId === "" || body.patch === null || typeof body.patch !== "object") throw new LedgerError("bad-request", "templateId 与 patch 必填");
		const request_ = {
			templateId: body.templateId,
			patch: sanitizePatch(body.patch)
		};
		const updated = await deps.updateWorkerType(request_);
		return {
			status: 200,
			body: JSON.stringify(updated)
		};
	});
	handle(WORKER_TYPES_ENABLED_PATH, ["POST"], async (request) => {
		const body = await readJsonBody(request);
		if (typeof body.templateId !== "string" || body.templateId === "" || typeof body.enabled !== "boolean") throw new LedgerError("bad-request", "templateId 与 enabled(布尔) 必填");
		const request_ = {
			templateId: body.templateId,
			enabled: body.enabled
		};
		const updated = await deps.setWorkerTypeEnabled(request_);
		return {
			status: 200,
			body: JSON.stringify(updated)
		};
	});
	handle(ROUTER_NOTIFICATIONS_ACK_PATH, ["POST"], async (request) => {
		const body = await readJsonBody(request);
		if (body === null || typeof body !== "object" || typeof body["cardId"] !== "string" || body["cardId"] === "") throw new LedgerError("bad-request", "cardId(字符串) 必填");
		if (!await deps.ackNotification(body["cardId"])) throw new LedgerError("card-not-found", `通知卡不存在或已确认: ${body["cardId"]}`);
		return {
			status: 200,
			body: JSON.stringify({ ok: true })
		};
	});
	handle(ROUTER_DEFAULTS_PATH, ["GET", "POST"], async (request) => {
		if (request.method === "GET") return {
			status: 200,
			body: JSON.stringify(await deps.getDefaults())
		};
		const body = await readJsonBody(request);
		if (body === null || typeof body !== "object" || typeof body["routerSystemPrompt"] !== "string" || typeof body["routerModel"] !== "string") throw new LedgerError("bad-request", "routerSystemPrompt 与 routerModel(字符串) 必填");
		const saved = await deps.saveDefaults({
			routerSystemPrompt: body["routerSystemPrompt"],
			routerModel: body["routerModel"]
		});
		return {
			status: 200,
			body: JSON.stringify(saved)
		};
	});
	handle(ROUTER_SPAWN_MODE_PATH, ["GET", "POST"], async (request) => {
		if (request.method === "GET") return {
			status: 200,
			body: JSON.stringify(await deps.getSpawnMode())
		};
		const mode = (await readJsonBody(request))["mode"];
		if (mode !== "cache-priority" && mode !== "minimal-face") throw new LedgerError("bad-request", "mode 必须是 'cache-priority' | 'minimal-face' 之一");
		const saved = await deps.saveSpawnMode(mode);
		return {
			status: 200,
			body: JSON.stringify(saved)
		};
	});
	handle(ROUTER_PROMPT_PATH, ["GET", "PUT"], async (request) => {
		if (request.method === "GET") {
			const sessionId = new URL(request.url ?? "/", "http://localhost").searchParams.get("sessionId") ?? "";
			if (sessionId === "") throw new LedgerError("bad-request", "sessionId 查询参数必填");
			const prompt = await deps.getSessionPrompt(sessionId);
			return {
				status: 200,
				body: JSON.stringify(prompt)
			};
		}
		const body = await readJsonBody(request);
		if (body === null || typeof body !== "object" || typeof body["sessionId"] !== "string" || body["sessionId"] === "" || typeof body["prompt"] !== "string") throw new LedgerError("bad-request", "sessionId(字符串) 与 prompt(字符串) 必填；prompt 空串 = 清除覆盖");
		await deps.saveSessionPrompt(body["sessionId"], body["prompt"]);
		return {
			status: 200,
			body: JSON.stringify({ ok: true })
		};
	});
	handle(ROUTER_TASKS_CONTROL_PATH, ["POST"], async (request) => {
		const body = await readJsonBody(request);
		if (typeof body.taskId !== "string" || body.taskId === "") throw new LedgerError("bad-request", "taskId 必填");
		const action = body.action;
		if (action !== "pause" && action !== "resume" && action !== "cancel" && action !== "redispatch" && action !== "accept" && action !== "reject" && action !== "rework") throw new LedgerError("bad-request", "action 必须是 'pause' | 'resume' | 'cancel' | 'redispatch' | 'accept' | 'reject' | 'rework' 之一");
		const note = pickString(body, "note");
		const result = await deps.controlTask(body.taskId, action, note);
		return {
			status: 200,
			body: JSON.stringify(result)
		};
	});
	handle(ROUTER_BREAKER_UNFREEZE_PATH, ["POST"], async () => {
		const report = await deps.unfreezeBreaker();
		return {
			status: 200,
			body: JSON.stringify(report)
		};
	});
	handle(ROUTER_EMERGENCY_PAUSE_PATH, ["POST"], async (request) => {
		const body = await readJsonBody(request);
		if (typeof body.routerSessionId !== "string" || body.routerSessionId === "") throw new LedgerError("bad-request", "routerSessionId 必填（当前 Router 会话 id）");
		const report = await deps.scopedPause(body.routerSessionId);
		return {
			status: 200,
			body: JSON.stringify(report)
		};
	});
	handle(ROUTER_HEALTH_PATH, ["GET"], async () => {
		const report = await deps.getHealth();
		return {
			status: 200,
			body: JSON.stringify(report)
		};
	});
}
/** 请求体字段守卫：字符串字段（缺席放行为 undefined）。 */
function pickString(source, field) {
	const value = source[field];
	if (value === void 0) return void 0;
	if (typeof value !== "string") throw new LedgerError("bad-request", `${field} 必须是字符串`);
	return value;
}
/** 请求体字段守卫：字符串数组字段（缺席放行为 undefined）。 */
function pickStringArray(source, field) {
	const value = source[field];
	if (value === void 0) return void 0;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new LedgerError("bad-request", `${field} 必须是字符串数组`);
	return [...value];
}
/**
* POST /router/worker-types 的建型输入：只采纳业务字段，templateId/origin/
* 时间戳等同名字段一律不采纳（宿主生成）；name 必填。
*/
function sanitizeCreateInput(body) {
	const name$1 = pickString(body, "name");
	if (name$1 === void 0 || name$1.trim() === "") throw new LedgerError("bad-request", "name 必填");
	const role = pickString(body, "role");
	if (role !== void 0 && role !== "worker" && role !== "supervisor") throw new LedgerError("bad-request", "role 只能是 worker 或 supervisor");
	const input = { name: name$1 };
	const description = pickString(body, "description");
	const systemPrompt = pickString(body, "systemPrompt");
	const models = pickStringArray(body, "models");
	const skills = pickStringArray(body, "skills");
	if (description !== void 0) input["description"] = description;
	if (systemPrompt !== void 0) input["systemPrompt"] = systemPrompt;
	if (models !== void 0) input["models"] = models;
	if (skills !== void 0) input["skills"] = skills;
	if (role !== void 0) input["role"] = role;
	if (typeof body["enabled"] === "boolean") input["enabled"] = body["enabled"];
	return input;
}
/** update 的 patch：只采纳可改字段（角色/启用态走各自通道，不进 patch）。 */
function sanitizePatch(raw) {
	const patch = {};
	const name$1 = pickString(raw, "name");
	const description = pickString(raw, "description");
	const systemPrompt = pickString(raw, "systemPrompt");
	const models = pickStringArray(raw, "models");
	const skills = pickStringArray(raw, "skills");
	if (name$1 !== void 0) patch["name"] = name$1;
	if (description !== void 0) patch["description"] = description;
	if (systemPrompt !== void 0) patch["systemPrompt"] = systemPrompt;
	if (models !== void 0) patch["models"] = models;
	if (skills !== void 0) patch["skills"] = skills;
	return patch;
}

//#endregion
//#region src/host/docs/render.ts
/** 无序列表行。 */
function bullets(items) {
	return items.map((item) => `- ${item}`).join("\n");
}
/** 列表或「无」占位。 */
function listOrNone(items) {
	return items.length > 0 ? bullets(items) : "无";
}
/** 渲染任务书全文。 */
function renderTaskBook(task, inputs = {}) {
	const materialLines = [...(inputs.materials ?? []).map((m) => `- ${m}`), ...(inputs.memoryRefs ?? []).map((m) => `- 记忆引用：${m}`)];
	return [
		`# 任务书 ${task.id}：${task.title}`,
		"",
		"## 目标",
		task.goal,
		"",
		"## 背景与范围",
		`- 所属项目：${task.projectId}`,
		`- 工作目录：${task.cwd}`,
		"",
		"## 约束",
		listOrNone(task.constraints),
		"",
		"## 验收条件",
		listOrNone(task.acceptance),
		"",
		"## 指派",
		`- 角色：${task.role}`,
		`- 专业类型：${task.templateId ?? "未指定"}`,
		"",
		"## 父任务与依赖",
		`- 父任务：${task.parentId ?? "无"}`,
		`- 依赖：${task.dependsOn.length > 0 ? task.dependsOn.join("、") : "无"}`,
		"",
		"## 输入材料",
		materialLines.length > 0 ? materialLines.join("\n") : "无",
		"",
		"## 来源引用",
		inputs.sourceRef ?? "无",
		"",
		"## 文档版本",
		`v${task.docVersion}`,
		""
	].join("\n");
}

//#endregion
//#region src/host/context/snapshot.ts
/** 状态 → 中文词。 */
const STATUS_LABEL = {
	draft: "草稿",
	queued: "排队中",
	dispatched: "已派发",
	running: "执行中",
	"waiting-user": "等待用户",
	blocked: "受阻",
	paused: "已暂停",
	"review-pending": "待验收",
	completed: "已完成",
	cancelled: "已取消",
	failed: "失败"
};
/**
* 快照里保留的任务：completed / cancelled 剔除；failed 只有绑定了执行会话的
* 才保留（失败待处理），无会话的 failed 空壳不进快照（v1.1 规格 §3.7）。
*/
function isSnapshotVisible(record) {
	if (record.status === "completed" || record.status === "cancelled") return false;
	if (record.status === "failed" && record.sessionId === void 0) return false;
	return true;
}
/** 完整短卡（多行）。 */
function fullCard(record, waiting) {
	const lines = [`[${record.id}] ${record.title} — ${STATUS_LABEL[record.status]}（${record.status}）`, `  目标：${record.goal}`];
	if (record.acceptance.length > 0) lines.push(`  验收：${record.acceptance.join("；")}`);
	const identity = [`类型 ${record.role}${record.templateId !== void 0 ? `/${record.templateId}` : ""}`];
	if (record.sessionId !== void 0) identity.push(`会话 ${record.sessionId}`);
	identity.push(`任务书 v${record.docVersion}`);
	lines.push(`  ${identity.join("，")}`);
	if (record.progress !== void 0 && record.progress !== "") lines.push(`  进度：${record.progress}`);
	if (record.dependsOn.length > 0) lines.push(`  依赖：${record.dependsOn.join("、")}`);
	if (waiting !== void 0 && waiting > 0) lines.push(`  待回答：${waiting} 个问题`);
	const latestConstraint = record.constraints[record.constraints.length - 1];
	if (latestConstraint !== void 0) lines.push(`  最新补充约束：${latestConstraint}`);
	return lines.join("\n");
}
/** 紧凑单行卡（超容量模式，一张不丢）。 */
function compactCard(record, waiting) {
	const parts = [
		`[${record.id}] ${record.title}`,
		STATUS_LABEL[record.status],
		`v${record.docVersion}`
	];
	if (record.sessionId !== void 0) parts.push(`会话 ${record.sessionId}`);
	if (record.progress !== void 0 && record.progress !== "") parts.push(record.progress);
	if (waiting !== void 0 && waiting > 0) parts.push(`待答 ${waiting} 问`);
	if (record.dependsOn.length > 0) parts.push(`依赖 ${record.dependsOn.join("、")}`);
	return parts.join(" | ");
}
/** 渲染活动账本快照文本（systemPrompt.context 的 text 缓存源）。 */
function renderLedgerSnapshot(tasks, options) {
	const visible = tasks.filter(isSnapshotVisible);
	if (visible.length === 0) return options.memoryBrief !== void 0 && options.memoryBrief !== "" ? `## 长期记忆摘要\n\n${options.memoryBrief}\n\n## 活动任务\n\n当前没有未结束任务。\n` : "当前没有未结束任务。所有任务均已完成或取消，可从归档检索。";
	const compact = visible.length > options.maxCards;
	const sections = [];
	if (options.memoryBrief !== void 0 && options.memoryBrief !== "") sections.push(`## 长期记忆摘要\n\n${options.memoryBrief}`);
	const header = compact ? `## 活动任务（${visible.length} 项，超上限 ${options.maxCards}，已切换单行紧凑模式）` : `## 活动任务（${visible.length} 项）`;
	const cards = visible.map((record) => {
		const waiting = options.openQuestions?.[record.id];
		return compact ? compactCard(record, waiting) : fullCard(record, waiting);
	});
	sections.push(`${header}\n\n${cards.join("\n\n")}`);
	return sections.join("\n\n");
}

//#endregion
//#region src/host/guard/emergency.ts
/** 暂停通知的固定措辞（告知 Router：你的活被停了，等用户指示）。 */
const SCOPED_PAUSE_NOTICE = "已暂停，等用户指示";
/** 在跑的任务状态（dispatched/running）——只有这两个值得打断。 */
function isLive(status) {
	return status === "dispatched" || status === "running";
}
/**
* 派发树闭包：某 Router 会话派出的任务 + 其下游子任务（主管再拆的那一层）。
*
* 宿主记的「派发者会话」（dispatchedBySessionId）为准：Router 会话派的直接
* 子任务记 Router 会话 id；主管在自己会话里派的下游子任务记主管的会话 id。
* 闭包 = 从 routerSessionId 出发，沿「派发者会话 → 该任务的执行会话」反复
* 并入新任务。
*
* 只保留在跑的（dispatched/running）且已绑执行会话的——其余状态不打扰，
* 无会话的任务无处可停。
*/
function scopedPauseTargets(records, routerSessionId) {
	const byDispatcher = /* @__PURE__ */ new Map();
	for (const record of records) {
		const dispatcher = record.dispatchedBySessionId;
		if (dispatcher === void 0 || dispatcher === "") continue;
		const bucket = byDispatcher.get(dispatcher);
		if (bucket === void 0) byDispatcher.set(dispatcher, [record]);
		else bucket.push(record);
	}
	const dispatchers = new Set([routerSessionId]);
	const inScope = /* @__PURE__ */ new Map();
	for (;;) {
		let grew = false;
		for (const dispatcher of [...dispatchers]) for (const record of byDispatcher.get(dispatcher) ?? []) {
			if (inScope.has(record.id)) continue;
			inScope.set(record.id, record);
			if (record.sessionId !== void 0 && record.sessionId !== "") {
				if (!dispatchers.has(record.sessionId)) {
					dispatchers.add(record.sessionId);
					grew = true;
				}
			}
		}
		if (!grew) break;
	}
	return [...inScope.values()].filter((record) => isLive(record.status) && typeof record.sessionId === "string" && record.sessionId !== "");
}
/** 执行作用域紧急暂停：算范围 → 逐个落账本 → 断会话 → 逐张落卡 → 告知 → 逐项报告。 */
async function runScopedPause(deps, routerSessionId) {
	const targets = await deps.targets(routerSessionId);
	const results = [];
	const paused = [];
	for (const target of targets) {
		const sessionId = target.sessionId;
		try {
			await deps.markPaused(target.id);
			const item = {
				taskId: target.id,
				title: target.title,
				sessionId,
				paused: true,
				interrupted: false
			};
			paused.push(item);
			results.push(item);
		} catch (error) {
			results.push({
				taskId: target.id,
				title: target.title,
				sessionId,
				paused: false,
				interrupted: false,
				detail: `落账本失败：${error instanceof Error ? error.message : String(error)}`
			});
		}
	}
	const sessionIds = paused.map((item) => item.sessionId);
	const outcomes = sessionIds.length > 0 ? await deps.interrupt(sessionIds) : [];
	const outcomeBySession = new Map(outcomes.map((entry) => [entry.sessionId, entry]));
	for (const item of paused) {
		const outcome = outcomeBySession.get(item.sessionId);
		if (outcome === void 0) {
			item.interrupted = false;
			item.detail = "中断结果缺失（如实：宿主未返回该会话的中断结果）";
			continue;
		}
		if (outcome.outcome === "accepted") {
			item.interrupted = true;
			if (outcome.detail !== void 0) item.detail = outcome.detail;
		} else {
			item.interrupted = false;
			item.detail = `中断失败：${outcome.detail ?? "原因未记录"}`;
		}
	}
	if (deps.notifyTask !== void 0) for (const item of results) {
		const summary = item.paused && item.interrupted ? `${SCOPED_PAUSE_NOTICE}：任务已暂停（紧急暂停只停当前 Router 派出的活，不影响别的会话）。` : `${SCOPED_PAUSE_NOTICE}：任务未完全停下——${item.detail ?? "原因未记录"}`;
		try {
			await deps.notifyTask({
				taskId: item.taskId,
				title: item.title,
				summary
			});
		} catch (error) {
			deps.logger?.warn(`紧急暂停的任务卡写入失败（逐项结果已在响应里如实带出）: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	let notified = false;
	let notifyDetail;
	if (deps.notifyRouter !== void 0) {
		const failedCount$1 = results.filter((item) => !item.paused || !item.interrupted).length;
		const text = failedCount$1 > 0 ? `${SCOPED_PAUSE_NOTICE}：你派出的 ${results.length} 个任务已停下，其中 ${failedCount$1} 个未完全停下（见任务卡）。请停止推进这些任务，等用户指示。` : `${SCOPED_PAUSE_NOTICE}：你派出的 ${results.length} 个任务已停下。请停止推进这些任务，等用户指示。`;
		try {
			await deps.notifyRouter(routerSessionId, text);
			notified = true;
		} catch (error) {
			notifyDetail = error instanceof Error ? error.message : String(error);
			deps.logger?.warn(`紧急暂停告知 Router 会话失败（暂停本身已生效）: ${notifyDetail}`);
		}
	}
	const failedCount = results.filter((item) => !item.paused || !item.interrupted).length;
	const report = {
		tasks: results,
		pausedCount: results.length - failedCount,
		failedCount,
		notified
	};
	if (notifyDetail !== void 0) report.notifyDetail = notifyDetail;
	return report;
}

//#endregion
//#region src/host/guard/notifications.ts
/** 完成卡动作集（规格 §5：打开会话 / 查看结果文档 / 退回重做 + 确认）。 */
function completionActions() {
	return [
		{
			action: "open-session",
			label: "打开会话"
		},
		{
			action: "view-result",
			label: "查看结果"
		},
		{
			action: "rework",
			label: "退回重做"
		},
		{
			action: "ack",
			label: "知道了"
		}
	];
}
/** 验收卡动作集（需求 §7.2 user 策略：验收通过 / 驳回返工 + 打开会话 / 确认）。 */
function acceptanceActions() {
	return [
		{
			action: "accept",
			label: "验收通过"
		},
		{
			action: "reject",
			label: "驳回返工"
		},
		{
			action: "open-session",
			label: "打开会话"
		},
		{
			action: "ack",
			label: "知道了"
		}
	];
}
/** 异常卡动作集（规格 §5：重派 / 取消 + 确认；unfreeze 由 B4 冻结卡追加）。 */
function anomalyActions() {
	return [
		{
			action: "open-session",
			label: "打开会话"
		},
		{
			action: "redispatch",
			label: "重派"
		},
		{
			action: "cancel",
			label: "取消任务"
		},
		{
			action: "ack",
			label: "知道了"
		}
	];
}
/**
* 暂停卡动作集（v1.4 作用域紧急暂停）：打开会话 / 取消任务 / 知道了。
*
* 与异常卡不同——**不给「重派」**：这张卡说的是「这个任务被暂停了」，重派会把
* 用户刚叫停的活立刻再开起来，正好和暂停的意思相反。要恢复走 control_task
* resume（工作台的恢复入口），不在卡上做。
*/
function pausedActions() {
	return [
		{
			action: "open-session",
			label: "打开会话"
		},
		{
			action: "cancel",
			label: "取消任务"
		},
		{
			action: "ack",
			label: "知道了"
		}
	];
}
/** 保留上限（超出先丢最老的已读卡，再丢最老卡）。 */
const DEFAULT_MAX_NOTIFICATION_CARDS = 100;
var NotificationStore = class {
	fs;
	path;
	newId;
	now;
	maxCards;
	logger;
	cards = [];
	loaded = false;
	/** 观测口（测试的新 ID 计数器用）。 */
	seq = 0;
	constructor(deps) {
		this.fs = deps.fs;
		this.path = deps.path;
		this.newId = deps.newId;
		this.now = deps.now ?? (() => Date.now());
		this.maxCards = typeof deps.maxCards === "number" && deps.maxCards >= 1 ? Math.floor(deps.maxCards) : DEFAULT_MAX_NOTIFICATION_CARDS;
		this.logger = deps.logger;
	}
	/** 首次访问装载（坏文件/版本不符从空白开始）。 */
	async ensureLoaded() {
		if (this.loaded) return;
		try {
			const parsed = JSON.parse(await this.fs.readFile(this.path));
			if (parsed !== null && typeof parsed === "object" && parsed.schemaVersion === 1 && Array.isArray(parsed.cards)) this.cards = parsed.cards.filter((card) => typeof card?.cardId === "string" && (card?.kind === "completion" || card?.kind === "anomaly"));
		} catch {}
		this.loaded = true;
	}
	async save() {
		try {
			const lastSlash = this.path.lastIndexOf("/");
			const parent = lastSlash <= 0 ? "/" : this.path.slice(0, lastSlash);
			await this.fs.mkdirp(parent);
			await this.fs.writeFile(this.path, JSON.stringify({
				schemaVersion: 1,
				cards: this.cards
			}, null, 2));
		} catch (error) {
			this.logger?.warn(`notifications.json 落盘失败（内存通知继续生效）: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/** 修剪：超上限先丢最老的已读卡，再丢最老卡。 */
	prune() {
		while (this.cards.length > this.maxCards) {
			let oldestAcked = -1;
			for (let i = this.cards.length - 1; i >= 0; i -= 1) if (this.cards[i].ack) {
				oldestAcked = i;
				break;
			}
			const dropAt = oldestAcked >= 0 ? oldestAcked : this.cards.length - 1;
			this.cards.splice(dropAt, 1);
		}
	}
	async push(input) {
		await this.ensureLoaded();
		const card = {
			cardId: this.newId(),
			kind: input.kind,
			...input.taskId !== void 0 ? { taskId: input.taskId } : {},
			title: input.title,
			summary: input.summary,
			actions: [...input.actions],
			...input.deliveryOrigin !== void 0 ? { deliveryOrigin: input.deliveryOrigin } : {},
			at: this.now(),
			ack: false
		};
		this.cards.unshift(card);
		this.prune();
		await this.save();
		return card;
	}
	async ack(cardId) {
		await this.ensureLoaded();
		const card = this.cards.find((entry) => entry.cardId === cardId && !entry.ack);
		if (card === void 0) return false;
		card.ack = true;
		await this.save();
		return true;
	}
	async pending() {
		await this.ensureLoaded();
		return this.cards.filter((card) => !card.ack);
	}
	async list() {
		await this.ensureLoaded();
		return [...this.cards];
	}
};

//#endregion
//#region src/host/core.ts
/** 深度：根任务 1，子任务 +1；parentId 链带 visited 防护。 */
function depthOf(ledger, taskId) {
	let depth = 0;
	const visited = /* @__PURE__ */ new Set();
	let cursor = taskId;
	while (cursor !== void 0 && !visited.has(cursor)) {
		visited.add(cursor);
		depth += 1;
		cursor = ledger.get(cursor)?.parentId;
	}
	return depth;
}
/** TaskRecord → TaskCard（role 字段：任务只会以 supervisor/worker 创建）。 */
function toCard(record, waiting) {
	const card = {
		taskId: record.id,
		title: record.title,
		goal: record.goal,
		status: record.status,
		role: record.role,
		templateId: record.templateId ?? "",
		waitingQuestions: waiting,
		docVersion: record.docVersion
	};
	if (record.progress !== void 0) card.progress = record.progress;
	if (record.sessionId !== void 0) card.sessionId = record.sessionId;
	if (record.parentId !== void 0) card.parentId = record.parentId;
	if (record.dispatchedBySessionId !== void 0) card.dispatchedBySessionId = record.dispatchedBySessionId;
	if (record.firstRequestCacheReadTokens !== void 0) card.firstRequestCacheReadTokens = record.firstRequestCacheReadTokens;
	return card;
}
/**
* 熔断冻结态的可见投影（lossless：未冻结只带 frozen；冻结才带原因与时间）。
* query_tasks.breaker（模型可见）与 RouterState.breaker（界面可见）共用它。
*/
async function breakerView(breaker) {
	const state = await breaker.state();
	const view = { frozen: state.frozen };
	if (state.frozen) {
		if (state.reason !== void 0) view.reason = state.reason;
		if (state.frozenAt !== void 0) view.frozenAt = state.frozenAt;
	}
	return view;
}
/**
* 派发重试上限（v1.1 规格 §2-4）：同一任务连续派发失败达上限自动 blocked，
* 禁止无限重试换模板碰运气。
*/
const DISPATCH_RETRY_CAP = 3;
/**
* templateId 收紧（v1.1 Task A4）：未知或已禁用的模板直接拒，错误带当前可用
* 清单（杜绝 general 式幻觉）。enabledTypes 由调用方传入当前启用子集。
*/
function assertTemplateUsable(templateId, enabledTypes) {
	if (enabledTypes.find((entry) => entry.templateId === templateId) !== void 0) return;
	const error = new LedgerError("template-unavailable", `未知或已禁用的 worker 模板: ${templateId}（可用：${enabledTypes.map((entry) => entry.templateId).join("、")}）`);
	Object.assign(error, { available: enabledTypes.map((entry) => entry.templateId) });
	throw error;
}
/** 派发失败的统一处理：分类上报熔断（v1.2 B1）、记账并通知 Router。infra 不进 per-task 重试预算（需求 §9.1）。 */
async function recordDispatchFailure(deps, ledger, taskId, title, error, notifyRouterSession) {
	const verdict = classifyDispatchFailure(error);
	await deps.breaker?.recordFailure({
		taskId,
		at: (deps.now ?? (() => Date.now()))(),
		class: verdict.class
	});
	const message = error instanceof Error ? error.message : String(error);
	if (verdict.class === "infra") {
		const failed$1 = await ledger.updateProgress(taskId, `派发失败（系统故障，不计任务重试）: ${message}`);
		if (notifyRouterSession !== void 0) try {
			await deps.bridge.notify(notifyRouterSession, `dispatch-infra-${taskId}`, `任务 ${taskId}「${title}」派发失败（系统故障）：${message}。这不是任务本身的问题：不要重试或换模板硬撞，熔断器正在计数；向用户如实报告，若收到「派发已冻结」则等用户解除冻结。`);
		} catch (notifyError) {
			deps.logger?.warn(`任务 ${taskId} 的 infra 失败通知投递失败: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`);
		}
		return {
			failed: failed$1,
			failureClass: verdict.class
		};
	}
	const failed = await ledger.recordDispatchFailure(taskId, `派发失败: ${message}`, { blockAt: DISPATCH_RETRY_CAP });
	if (failed.status === "blocked") await deps.notifications?.push({
		kind: "anomaly",
		taskId,
		title,
		summary: `连续 ${failed.retryCount} 次派发失败，任务已自动阻塞：${message}`,
		actions: anomalyActions()
	});
	if (failed.status === "blocked" && notifyRouterSession !== void 0) await deps.bridge.notify(notifyRouterSession, `dispatch-blocked-${taskId}`, `任务 ${taskId}「${title}」连续 ${failed.retryCount} 次派发失败，已自动受阻（blocked）。请检查模板/环境问题后人工介入；不要继续重试同一模板。最近错误：${message}`);
	return {
		failed,
		failureClass: verdict.class
	};
}
function createRouterCore(deps) {
	const { ledger, bridge, relay, driver, scheduler, ui, hosts, config } = deps;
	/** 待答问题计数（taskId → open 数）。 */
	const waitingCounts = async () => {
		const open$1 = await ledger.openQuestions();
		const counts = {};
		for (const question of open$1) if (question.taskId !== void 0) counts[question.taskId] = (counts[question.taskId] ?? 0) + 1;
		return counts;
	};
	/** 调用方会话绑定的任务（决定 caller 的角色与项目归属）。 */
	const taskBySession = async (sessionId) => {
		return (await ledger.listAll()).find((record) => record.sessionId === sessionId);
	};
	/**
	* 调用方会话的真实角色（v1.3 A1：superset 工具行的执行层硬闸数据源）。
	* 账本绑定优先（任务会话=其角色）；Router 会话登记其次；都没有 → undefined
	* （工具层按 worker 最严兜底）。
	*/
	const callerRoleOf = async (sessionId) => {
		const record = await taskBySession(sessionId);
		if (record !== void 0) return record.role;
		if (ui.routerSessions().some((entry) => entry.sessionId === sessionId)) return "router";
	};
	/** Router 会话所在 workspace（sessionIds 成员扫描；registry 是同步投影）。 */
	const workspaceOfSession = (sessionId) => hosts.workspaceRegistry.list().find((workspace) => workspace.sessionIds?.includes(sessionId));
	/** 派发后的公共收尾：打标、加标签、刷快照。 */
	const afterDispatch = async (record, sessionId, workspaceId) => {
		if (sessionId !== void 0) {
			driver.onDispatched(sessionId);
			if (workspaceId !== void 0 && !workspaceId.startsWith("cwd:")) await ui.addTab(workspaceId, sessionId, record.id);
		}
		await refreshSnapshot();
	};
	let snapshotCache = "";
	/**
	* 同一任务的派发/重派串行化锁（评审修复：并发补充同一任务时，后到者在锁内
	* 重新过闸门，不破封顶、不重复派发）。JS 单线程下按 taskId 链式排队即可。
	*/
	const taskLocks = /* @__PURE__ */ new Map();
	const withTaskLock = async (taskId, fn) => {
		const run = (taskLocks.get(taskId) ?? Promise.resolve()).then(fn, fn);
		taskLocks.set(taskId, run.then(() => void 0, () => void 0));
		return run;
	};
	/** 任务的依赖是否全部 completed（重派闸门：未满足的 queued 任务只升版等解锁）。 */
	const depsSatisfied = async (taskId) => {
		const task = ledger.get(taskId);
		if (task === void 0) return false;
		if (task.dependsOn.length === 0) return true;
		const all = await ledger.listAll();
		const byId = new Map(all.map((entry) => [entry.id, entry]));
		return task.dependsOn.every((depId) => byId.get(depId)?.status === "completed");
	};
	/**
	* 执行类工具（report_progress/complete_task/report_blocker）的归属复核：
	* 调用方必须是任务绑定的会话（纵深防御——assertCallerRole 已在工具层查过
	* 一次，这里用核心的账本再拦一道）。
	*/
	const mustOwn = (callerSessionId$1, taskId) => {
		const record = ledger.get(taskId);
		if (record === void 0) throw new LedgerError("task-not-found", `任务不存在: ${taskId}`);
		assertCallerRole(record.role, "report_progress", callerSessionId$1, { get: (id) => ledger.get(id) }, taskId);
		return record;
	};
	const refreshSnapshot = async () => {
		snapshotCache = renderLedgerSnapshot(await ledger.listAll(), {
			maxCards: deps.maxActiveCards ?? 12,
			openQuestions: await waitingCounts()
		});
	};
	/** 记账时钟（熔断事件时间戳；缺省 Date.now）。 */
	const now = deps.now ?? (() => Date.now());
	/** 熔断冻结拒绝的统一文案（规格 §2：明确告知停止重试并向用户报告）。 */
	const frozenRejection = (reason) => new LedgerError("dispatch-frozen", `派发已冻结（${reason ?? "原因未记录"}）：请停止重试并向用户报告`);
	/** 熔断冻结时一切派发被拦（dispatch_task / create_worker_type 共用入口检查）。 */
	const assertDispatchOpen = async () => {
		if (deps.breaker === void 0) return;
		const state = await deps.breaker.state();
		if (state.frozen) throw frozenRejection(state.reason);
	};
	/**
	* 当前启用类型的实时清单：类型存储在册时用它的同步投影（WorkerTypeStore 在
	* 启动装载后维护），缺席退回 v1 Config 模板（降级兼容）。
	*/
	const enabledTemplates = () => deps.types !== void 0 ? deps.types.enabled() : [...config.templates];
	const core = {
		enabledTemplates,
		listWorkerTypes() {
			return deps.types !== void 0 ? deps.types.summaries() : config.templates.map((template) => ({
				...template,
				enabled: true,
				origin: "user"
			}));
		},
		async createWorkerType(callerSessionId$1, input) {
			await assertDispatchOpen();
			const face = deps.types;
			if (face?.createRouterType === void 0) throw new LedgerError("types-unavailable", "类型存储未接线（WorkerTypesFace.createRouterType 缺席），无法现场创建 worker 类型");
			const { record, presetRegistered } = await face.createRouterType(input);
			return {
				templateId: record.templateId,
				presetRegistered
			};
		},
		async dispatchTask(callerSessionId$1, input) {
			await assertDispatchOpen();
			assertTemplateUsable(input.templateId, enabledTemplates());
			const callerTask = await taskBySession(callerSessionId$1);
			const callerRole = callerTask?.role ?? "router";
			const parentTaskId = callerTask?.id;
			const verdict = scheduler.dispatchGuard({
				sessionIdRole: callerRole,
				parentTaskId,
				depth: parentTaskId !== void 0 ? depthOf(ledger, parentTaskId) : 0
			}, {
				role: input.role,
				dependsOn: input.dependsOn?.map((ref) => ref.taskId)
			});
			if (!verdict.ok) throw new LedgerError(verdict.code, `派发被拒（${verdict.code}）：${dispatchRejectionText(verdict.code, callerRole)}`);
			if (deps.budgets !== void 0) if (callerRole === "supervisor") {
				if (deps.budgets.supervisorFrozen(callerSessionId$1)) throw new LedgerError("supervisor-failure-budget", `连续 ${deps.budgets.snapshot(callerSessionId$1).consecutiveDispatchFailures} 次派发失败，你的派发已被冻结：请停止重试，调用 report_blocker 向用户报告阻塞`);
			} else {
				const budgetVerdict = deps.budgets.tryConsumeTaskDispatch(callerSessionId$1);
				if (!budgetVerdict.ok) throw new LedgerError(budgetVerdict.code, `本轮（当前用户消息）已派发过 ${deps.budgets.snapshot(callerSessionId$1).taskLimitPerTurn} 个任务。要派第二个任务，请先调用 ask_user 列出计划与理由征得用户确认；确认后预算清零重计`);
			}
			const workspace = workspaceOfSession(callerSessionId$1);
			const cwd = workspace?.path ?? callerTask?.cwd ?? process.cwd();
			const projectId = workspace?.id ?? `cwd:${cwd}`;
			const record = await ledger.createTask({
				title: input.title,
				goal: input.goal,
				acceptance: input.acceptance,
				constraints: input.constraints ?? [],
				projectId,
				cwd,
				role: input.role,
				templateId: input.templateId,
				parentId: parentTaskId,
				dispatchedBySessionId: callerSessionId$1,
				dependsOn: input.dependsOn?.map((ref) => ref.taskId) ?? [],
				acceptancePolicy: input.acceptancePolicy ?? "auto"
			});
			const docs = deps.docsFor(record.cwd);
			const book = renderTaskBook(record, {
				materials: input.materials,
				sourceRef: `router 会话 ${callerSessionId$1}`
			});
			const docPath = await docs.initTask(record, book);
			await deps.breaker?.recordCreation(record.id, now());
			try {
				const { sessionId } = await bridge.dispatchTask(record.id, { forkFrom: callerSessionId$1 });
				deps.budgets?.recordDispatchSuccess(callerSessionId$1);
				driver.onDispatched(callerSessionId$1);
				await afterDispatch(record, sessionId, workspace?.id);
				return {
					taskId: record.id,
					docPath,
					sessionId
				};
			} catch (error) {
				deps.budgets?.recordDispatchFailure(callerSessionId$1);
				const { failed, failureClass } = await recordDispatchFailure(deps, ledger, record.id, record.title, error, callerSessionId$1);
				await refreshSnapshot();
				throw new LedgerError("dispatch-failed", `任务 ${record.id} 派发失败（任务保持${failed.status === "blocked" ? "blocked" : record.status}${failureClass === "infra" ? "；系统故障不计任务重试" : `，累计失败 ${failed.retryCount ?? 0} 次`}）: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
		async supplementTask(callerSessionId$1, taskId, additions) {
			await assertDispatchOpen();
			const callerRole = (await taskBySession(callerSessionId$1))?.role ?? "router";
			const record = ledger.get(taskId);
			if (record === void 0) throw new LedgerError("task-not-found", `任务不存在: ${taskId}`);
			if (isTerminal(record.status)) throw new LedgerError("illegal-transition", `终态任务不可补充: ${taskId}（${record.status}）`);
			const newVersion = await withTaskLock(taskId, async () => {
				const bumped = await ledger.supplement(taskId, additions);
				await deps.docsFor(record.cwd).supplement(taskId, bumped - 1, additions);
				let delivered;
				try {
					delivered = await bridge.supplementTo(taskId);
				} catch (error) {
					const live = ledger.get(taskId);
					if (live.sessionId !== void 0 && (live.status === "draft" || live.status === "queued")) {
						deps.budgets?.recordDispatchFailure(callerSessionId$1);
						const { failed, failureClass } = await recordDispatchFailure(deps, ledger, taskId, live.title, error, callerSessionId$1);
						await refreshSnapshot();
						throw new LedgerError("dispatch-failed", `任务 ${taskId} 重投失败（任务保持${failed.status === "blocked" ? "blocked" : live.status}${failureClass === "infra" ? "；系统故障不计任务重试" : `，累计失败 ${failed.retryCount ?? 0} 次`}）: ${error instanceof Error ? error.message : String(error)}`);
					}
					throw error;
				}
				if (delivered.sessionId !== void 0) {
					deps.budgets?.recordDispatchSuccess(callerSessionId$1);
					driver.onDispatched(delivered.sessionId);
					driver.onDispatched(callerSessionId$1);
					const live = ledger.get(taskId);
					if (live.status === "draft" || live.status === "queued") {
						if (live.status === "draft") await ledger.transition(taskId, "queued");
						await ledger.transition(taskId, "dispatched");
						const dispatched = ledger.get(taskId);
						await afterDispatch(dispatched, delivered.sessionId, dispatched.projectId.startsWith("cwd:") ? void 0 : dispatched.projectId);
					}
				} else {
					const live = ledger.get(taskId);
					if (live.sessionId === void 0 && (live.status === "draft" || live.status === "queued") && await depsSatisfied(taskId)) {
						if (callerRole === "supervisor" && deps.budgets?.supervisorFrozen(callerSessionId$1)) throw new LedgerError("supervisor-failure-budget", `连续 ${deps.budgets.snapshot(callerSessionId$1).consecutiveDispatchFailures} 次派发失败，你的派发已被冻结：请停止重试，调用 report_blocker 向用户报告阻塞`);
						try {
							const { sessionId } = await bridge.dispatchTask(taskId);
							deps.budgets?.recordDispatchSuccess(callerSessionId$1);
							if (sessionId !== void 0) driver.onDispatched(sessionId);
							driver.onDispatched(callerSessionId$1);
							const dispatched = ledger.get(taskId);
							await afterDispatch(dispatched, sessionId, dispatched.projectId.startsWith("cwd:") ? void 0 : dispatched.projectId);
						} catch (error) {
							deps.budgets?.recordDispatchFailure(callerSessionId$1);
							const { failed, failureClass } = await recordDispatchFailure(deps, ledger, taskId, live.title, error, callerSessionId$1);
							await refreshSnapshot();
							throw new LedgerError("dispatch-failed", `任务 ${taskId} 重派失败（任务保持${failed.status === "blocked" ? "blocked" : live.status}${failureClass === "infra" ? "；系统故障不计任务重试" : `，累计失败 ${failed.retryCount ?? 0} 次`}）: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				}
				return bumped;
			});
			await refreshSnapshot();
			return { docVersion: newVersion };
		},
		async queryTasks(filter, viewerSessionId) {
			const records = await ledger.listAll();
			const counts = await waitingCounts();
			let cards = records.map((record) => toCard(record, counts[record.id] ?? 0));
			if (filter?.status !== void 0 && filter.status.length > 0) {
				const wanted = new Set(filter.status);
				cards = cards.filter((card) => wanted.has(card.status));
			}
			if (filter?.taskId !== void 0) cards = cards.filter((card) => card.taskId === filter.taskId);
			const result = { tasks: cards };
			if (deps.budgets !== void 0 && viewerSessionId !== void 0) result.budgets = deps.budgets.snapshot(viewerSessionId);
			if (deps.breaker !== void 0) result.breaker = await breakerView(deps.breaker);
			return result;
		},
		async controlTask(callerSessionId$1, taskId, action, note) {
			const record = ledger.get(taskId);
			if (record === void 0) throw new LedgerError("task-not-found", `任务不存在: ${taskId}`);
			if (action === "pause") {
				await ledger.transition(taskId, "paused");
				if (record.sessionId !== void 0) await bridge.notify(record.sessionId, `pause-${taskId}`, `任务 ${taskId}「${record.title}」已暂停。请停止推进，等待恢复指示；不要提交完成。`);
			} else if (action === "resume") {
				await ledger.transition(taskId, "running");
				if (record.sessionId !== void 0) await bridge.notify(record.sessionId, `resume-${taskId}`, `任务 ${taskId}「${record.title}」已恢复，请继续按任务书当前版本推进。`);
			} else if (action === "accept" || action === "reject") {
				const isUser = callerSessionId$1 === "user";
				if (record.status !== "review-pending") throw new LedgerError("illegal-transition", `验收仅适用于待验收任务: ${taskId}（当前 ${record.status}）`);
				const expected = isUser ? "user" : "supervisor";
				if (record.acceptancePolicy !== expected) throw new LedgerError("bad-request", record.acceptancePolicy === "user" ? `任务 ${taskId} 的验收策略是 user：须由用户在验收卡上确认，模型不得代验` : `任务 ${taskId} 的验收策略是 ${record.acceptancePolicy}：${isUser ? "用户验收卡只处理 user 策略任务" : "auto 策略无需验收，supervisor 策略由派发者经 control_task 验收"}`);
				if (!isUser) {
					const parentSession = record.parentId !== void 0 ? ledger.get(record.parentId)?.sessionId : void 0;
					if (record.dispatchedBySessionId !== callerSessionId$1 && parentSession !== callerSessionId$1) throw new LedgerError("role-forbidden", `只有派发者或上级任务会话可以验收任务 ${taskId}`);
				}
				if (action === "accept") {
					if ((await ledger.listAll()).some((t) => t.parentId === taskId && !isTerminal(t.status))) throw new LedgerError("illegal-transition", `任务 ${taskId} 还有未结子任务，不能验收通过`);
					await finalizeCompletion(record, await ledger.accept(taskId, isUser ? "user" : "supervisor"), "worker", callerSessionId$1);
				} else {
					const noteText = note !== void 0 && note.trim() !== "" ? note.trim() : "验收驳回：请按验收意见返工后重新提交 complete_task";
					await ledger.reject(taskId, noteText);
					await core.supplementTask(callerSessionId$1, taskId, [`验收驳回返工：${noteText}`]);
				}
			} else if (action === "rework") {
				if (callerSessionId$1 !== "user") throw new LedgerError("role-forbidden", `退回重做是用户在完成卡上的动作: ${taskId}`);
				const noteText = note !== void 0 && note.trim() !== "" ? note.trim() : "用户退回重做：请核验交付是否真正达成验收条件，补齐后重新提交 complete_task";
				await ledger.rework(taskId, noteText);
				await core.supplementTask("user", taskId, [`退回重做：${noteText}`]);
			} else {
				await ledger.cancel(taskId, `cancelled by ${callerSessionId$1}`);
				await bridge.notifyCancel(taskId);
			}
			await refreshSnapshot();
			return { status: ledger.get(taskId)?.status ?? record.status };
		},
		async dispatchReady() {
			await assertDispatchOpen();
			let dispatched = 0;
			for (const task of await scheduler.readyTasks()) try {
				await withTaskLock(task.id, async () => {
					const live = ledger.get(task.id);
					if (live?.status !== "queued") return;
					const delivered = await bridge.dispatchTask(task.id);
					const workspace = live.projectId.startsWith("cwd:") ? void 0 : live.projectId;
					await afterDispatch(live, delivered.sessionId, workspace);
					dispatched += 1;
				});
			} catch (error) {
				const { failureClass } = await recordDispatchFailure(deps, ledger, task.id, task.title, error, ui.routerSessions()[0]?.sessionId);
				await refreshSnapshot();
				deps.logger?.warn(`任务 ${task.id} 补派失败（${failureClass}${failureClass === "task" ? `，retryCount=${ledger.get(task.id)?.retryCount}` : "，不计任务重试"}）: ${error instanceof Error ? error.message : String(error)}`);
			}
			return { dispatched };
		},
		async searchHistory(_callerSessionId, query, scope) {
			if (deps.memory === void 0) return {
				hits: [],
				note: "记忆服务未配置"
			};
			try {
				return { hits: await deps.memory.search(query, scope) };
			} catch (error) {
				deps.logger?.warn(`记忆检索失败: ${error instanceof Error ? error.message : String(error)}`);
				return {
					hits: [],
					note: "记忆检索失败"
				};
			}
		},
		async reportProgress(callerSessionId$1, taskId, progress) {
			const record = mustOwn(callerSessionId$1, taskId);
			await ledger.updateProgress(taskId, progress);
			await deps.docsFor(record.cwd).writeProgress(taskId, progress);
			await refreshSnapshot();
			return { ok: true };
		},
		async completeTask(callerSessionId$1, taskId, input) {
			const record = mustOwn(callerSessionId$1, taskId);
			const wasTerminal = isTerminal(record.status);
			const priorStatus = record.status;
			const completed = await ledger.complete(taskId, {
				docVersion: input.docVersion,
				summary: input.summary,
				deliverables: input.deliverables,
				acceptanceEvidence: input.acceptanceEvidence,
				openIssues: input.leftovers,
				...input.deliveryOrigin !== void 0 ? { deliveryOrigin: input.deliveryOrigin } : {}
			});
			if (completed.result !== void 0) await deps.docsFor(record.cwd).writeResult(taskId, completed.result);
			let pendingFrom;
			if (completed.status === "review-pending") pendingFrom = completed.acceptancePolicy === "user" ? "user" : "supervisor";
			if (completed.status === "completed" && !wasTerminal) await finalizeCompletion(record, completed, input.deliveryOrigin ?? "worker", callerSessionId$1);
			if (completed.status === "review-pending" && priorStatus !== "review-pending") await announceAcceptance(completed);
			await refreshSnapshot();
			return pendingFrom !== void 0 ? {
				accepted: completed.status === "completed",
				status: completed.status,
				pendingFrom
			} : {
				accepted: completed.status === "completed",
				status: completed.status
			};
		},
		async reportBlocker(callerSessionId$1, taskId, reason) {
			mustOwn(callerSessionId$1, taskId);
			const blocked = ledger.get(taskId);
			await ledger.reportBlocker(taskId, reason);
			await deps.notifications?.push({
				kind: "anomaly",
				taskId,
				title: blocked?.title ?? taskId,
				summary: reason,
				actions: anomalyActions()
			});
			await refreshSnapshot();
			return { status: "blocked" };
		},
		getTask(taskId) {
			return ledger.get(taskId);
		},
		async scopedPause(routerSessionId) {
			if (!ui.routerSessions().some((entry) => entry.sessionId === routerSessionId)) throw new LedgerError("bad-request", `不是已登记的 Router 会话: ${routerSessionId}`);
			const report = await runScopedPause({
				targets: async () => scopedPauseTargets(await ledger.listAll(), routerSessionId),
				markPaused: async (taskId) => {
					await ledger.transition(taskId, "paused");
				},
				interrupt: (sessionIds) => bridge.interruptTaskSessions(sessionIds),
				notifyTask: async (input) => deps.notifications?.push({
					kind: "anomaly",
					taskId: input.taskId,
					title: input.title,
					summary: input.summary,
					actions: pausedActions()
				}),
				notifyRouter: async (sessionId, text) => {
					await bridge.notify(sessionId, `scoped-pause-${sessionId}`, text);
				},
				logger: deps.logger
			}, routerSessionId);
			await refreshSnapshot();
			return report;
		},
		callerRoleOf
	};
	/**
	* 完成副作用统一执行（需求 §7.2）：worker 提交被直接接受、验收通过都走这里——
	* 熔断创建基准清除、完成卡、记忆、通知上级、解锁依赖自动派发、父任务级联重判。
	* Router 不在生成也能推进。
	*/
	async function finalizeCompletion(record, completed, deliveryOrigin, callerSessionId$1) {
		const result = completed.result;
		if (result === void 0) return;
		const taskId = completed.id;
		await deps.breaker?.recordCompletion(taskId, now());
		const cacheLine = completed.firstRequestCacheReadTokens !== void 0 ? `\n首请求缓存命中 ${completed.firstRequestCacheReadTokens} tok` : "";
		await deps.notifications?.push({
			kind: "completion",
			taskId,
			title: record.title,
			summary: `${result.summary}${cacheLine}`,
			actions: completionActions(),
			deliveryOrigin
		});
		deps.memory?.onTaskCompleted({
			taskId,
			title: record.title,
			summary: result.summary,
			resultRelPath: `${deps.tasksDir ?? ".router"}/tasks/${taskId}/result.md`,
			sessionId: record.sessionId
		});
		const parent = completed.parentId !== void 0 ? ledger.get(completed.parentId) : void 0;
		if (parent?.sessionId !== void 0 && parent.sessionId !== callerSessionId$1) await bridge.notify(parent.sessionId, `notice-${taskId}-completed`, `子任务 ${taskId}「${record.title}」已完成：${result.summary}`);
		const unlocked = await scheduler.onCompleted(taskId);
		for (const nextTask of unlocked) {
			if (deps.breaker !== void 0 && (await deps.breaker.state()).frozen) {
				deps.logger?.warn(`派发已冻结：任务 ${nextTask.id} 解锁后保持 queued，解除冻结后补派`);
				continue;
			}
			try {
				await withTaskLock(nextTask.id, async () => {
					const delivered = await bridge.dispatchTask(nextTask.id);
					const workspace = nextTask.projectId.startsWith("cwd:") ? void 0 : nextTask.projectId;
					await afterDispatch(nextTask, delivered.sessionId, workspace);
				});
			} catch (error) {
				const { failureClass } = await recordDispatchFailure(deps, ledger, nextTask.id, nextTask.title, error, ui.routerSessions()[0]?.sessionId);
				await refreshSnapshot();
				deps.logger?.warn(`任务 ${nextTask.id} 解锁后派发失败（${failureClass}${failureClass === "task" ? `，retryCount=${ledger.get(nextTask.id)?.retryCount}` : "，不计任务重试"}）: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (parent?.status === "review-pending" && parent.sessionId !== void 0 && parent.sessionId !== callerSessionId$1 && parent.result !== void 0) {
			if (!(await ledger.listAll()).some((t) => t.parentId === parent.id && !isTerminal(t.status))) await core.completeTask(parent.sessionId, parent.id, {
				docVersion: parent.docVersion,
				summary: parent.result.summary,
				deliverables: parent.result.deliverables,
				acceptanceEvidence: parent.result.acceptanceEvidence,
				leftovers: parent.result.openIssues
			});
		}
	}
	/** 新进入 review-pending 的验收通知（需求 §7.2）：user 出验收卡，supervisor 通知验收人。 */
	async function announceAcceptance(task) {
		if (task.acceptancePolicy === "user") {
			await deps.notifications?.push({
				kind: "completion",
				taskId: task.id,
				title: `待验收：${task.title}`,
				summary: `${task.result?.summary ?? ""}\n验收策略：用户确认——验收通过后完成；驳回将退回原执行者返工。`,
				actions: acceptanceActions()
			});
			return;
		}
		if (task.acceptancePolicy === "supervisor") {
			const parentSession = task.parentId !== void 0 ? ledger.get(task.parentId)?.sessionId : void 0;
			const target = task.dispatchedBySessionId ?? parentSession;
			if (target !== void 0) await bridge.notify(target, `acceptance-${task.id}`, `任务 ${task.id}「${task.title}」已提交交付，等你验收：control_task action=accept 通过（有未结子任务会被拒），action=reject 附 note 驳回返工。结果摘要：${task.result?.summary ?? ""}`);
		}
	}
	return {
		core,
		workbench: {
			async state(workspaceId) {
				const records = await ledger.listAll();
				const counts = await waitingCounts();
				const bySession = new Map(records.filter((r) => r.sessionId !== void 0).map((r) => [r.sessionId, r]));
				const byId = new Map(records.map((record) => [record.id, record]));
				const tabRows = workspaceId !== void 0 ? ui.tabs(workspaceId) : ui.allTabs();
				const notificationCards = await deps.notifications?.pending() ?? [];
				return {
					routerSessions: ui.routerSessions(),
					tasks: records.map((record) => toCard(record, counts[record.id] ?? 0)),
					questions: relay.pendingCards(),
					tabs: tabRows.filter((row) => !isHuskTask(row.taskId !== void 0 ? byId.get(row.taskId) : void 0)).map((row) => {
						const taskRecord = bySession.get(row.sessionId);
						return {
							sessionId: row.sessionId,
							title: taskRecord !== void 0 ? `${taskRecord.id} ${taskRecord.title}` : row.sessionId,
							taskId: taskRecord?.id ?? row.taskId,
							taskStatus: taskRecord?.status,
							running: deps.isRunning(row.sessionId)
						};
					}),
					templates: enabledTemplates(),
					types: deps.types !== void 0 ? deps.types.summaries() : config.templates.map((template) => ({
						...template,
						enabled: true,
						origin: "user"
					})),
					...deps.breaker !== void 0 ? { breaker: await breakerView(deps.breaker) } : {},
					...notificationCards.length > 0 ? { notifications: notificationCards } : {}
				};
			},
			async createRouterSession(workspaceId, name$1) {
				const title = name$1 ?? "Router";
				const created = await hosts.sessionController.create({
					workspaceId,
					agentPreset: config.routerPreset
				}, deps.signal);
				const ref = (await deps.routerDefaults?.get())?.routerModel ?? "";
				const parsed = ref !== "" ? parseModelRef(ref) : void 0;
				if (parsed !== void 0 && hosts.sessionController.selectModel !== void 0) try {
					await hosts.sessionController.selectModel({
						sessionId: created.sessionId,
						provider: parsed.provider,
						model: parsed.model
					}, deps.signal);
				} catch (error) {
					deps.logger?.warn(`Router 会话默认模型钉定失败（保持宿主默认路由）: ${error instanceof Error ? error.message : String(error)}`);
				}
				await hosts.sessionController.rename({
					sessionId: created.sessionId,
					title
				}, deps.signal);
				await ui.addRouterSession(created.sessionId, workspaceId, title);
				return { sessionId: created.sessionId };
			},
			async answerQuestion(questionId, answers) {
				await relay.answerQuestion(questionId, answers);
			},
			async closeTab(workspaceId, sessionId) {
				return ui.removeTab(workspaceId, sessionId);
			},
			pendingQuestions() {
				return relay.pendingCards();
			}
		},
		snapshotText: () => snapshotCache,
		refreshSnapshot,
		recoverOrphans: () => relay.recoverOrphans()
	};
}
/** 派发拒绝的补充说明（给模型看得懂的下一步）。 */
function dispatchRejectionText(code, callerRole) {
	if (code === "role-forbidden" && callerRole === "worker") return "工作型角色无权派发任务";
	if (code === "role-forbidden") return "主管之下只能派 worker 或子代理，不能再派主管（v1.1 规格 §3.4 禁主管链）";
	if (code === "depth-exceeded") return "超过最大递归深度，请把工作合并进当前任务或改派 supervisor";
	return "依赖命中了自身的祖先任务（环），请换依赖对象";
}

//#endregion
//#region src/host/prompts/worker-instructions.ts
/**
* worker 执行指引（计划 B4；v1.1 C6 提问纪律同步）：
* 随任务书全文一起投递给执行会话的附加文本。
*
* 任务书说「做什么」，这份指引说「在这个编排系统里怎么工作」。
*/
const workerInstructions = `【执行指引】

- 上面是任务书全文。先读目标、约束与验收条件，再动手；工作目录与依赖任务见任务书相应小节。
- 有合理默认就继续做，不要停下来问；提问前先看任务书里是否已有答案。真要问才用 ask_user：问题会汇集到用户界面的浮窗，用户的回答会直接回到你的工具结果里。等答案期间不要凭空编造。
- 用户不是执行器：禁止让用户执行命令或粘贴输出。缺环境事实就自己用工具查，查不到或工具不足用 report_blocker 报告阻塞，不要硬撑，更不要用完成工具掩盖。
- 长任务请阶段性用 report_progress 汇报一句话进度，让编排方与用户能看到推进。
- 完成必须调用 complete_task 提交：结果摘要、交付物引用、验收依据；提交时带的版本号必须是任务书末尾标注的当前版本（docVersion）——版本不符会被拒，说明期间有补充版本，先读最新版本再继续。
- 工作期间若收到任务书的新版本（补充约束），以最新版本为准，旧的完成提交按新版本重算。
- 完成后自然收尾即可；是否完成的判定由编排方按验收策略处理，不要重复提交。
- 输出结束后若收到【系统收尾提醒】（系统自动消息，非用户新指令）：立即按其指引调用 complete_task 或 report_blocker 收尾；不做回应会被系统独立判定并可能以「系统判定」结单。
`;

//#endregion
//#region src/host/prompts/session-prompt.ts
var SessionPromptStore = class {
	fs;
	file;
	prompts = /* @__PURE__ */ new Map();
	loaded = false;
	constructor(fs, file) {
		this.fs = fs;
		this.file = file;
	}
	/** 装载（幂等）：文件缺席或损坏 → 空表起步（覆盖全丢等价于全部回落默认，不炸装载）。 */
	async load() {
		if (this.loaded) return;
		let file = null;
		try {
			file = JSON.parse(await this.fs.readFile(this.file));
		} catch {
			file = null;
		}
		if (file !== null && file.prompts !== null && typeof file.prompts === "object") {
			for (const [sessionId, text] of Object.entries(file.prompts)) if (sessionId !== "" && typeof text === "string" && text.trim() !== "") this.prompts.set(sessionId, text);
		}
		this.loaded = true;
	}
	/** 同步读覆盖文本（未 load 或无覆盖 → undefined；返回值必非空）。 */
	get(sessionId) {
		assertSessionId(sessionId);
		return this.prompts.get(sessionId);
	}
	/** 写覆盖（空串/纯空白拒收——清空走 clear）；一次落盘，失败回滚内存。 */
	async set(sessionId, text) {
		assertSessionId(sessionId);
		if (typeof text !== "string" || text.trim() === "") throw new LedgerError("invalid-input", "系统提示词覆盖不能为空（清空请走 clear）");
		await this.commit(() => {
			this.prompts.set(sessionId, text);
		});
	}
	/** 清覆盖（回落默认；不存在的会话是 no-op）。 */
	async clear(sessionId) {
		assertSessionId(sessionId);
		if (!this.prompts.has(sessionId)) return;
		await this.commit(() => {
			this.prompts.delete(sessionId);
		});
	}
	async commit(mutate) {
		await this.load();
		mutate();
		const file = {
			schemaVersion: 1,
			prompts: Object.fromEntries(this.prompts)
		};
		try {
			const parent = this.file.slice(0, this.file.lastIndexOf("/")) || "/";
			await this.fs.mkdirp(parent);
			await this.fs.writeFile(this.file, JSON.stringify(file, null, 2));
		} catch (cause) {
			this.loaded = false;
			this.prompts.clear();
			await this.load();
			throw new LedgerError("persistence-failed", `会话提示词保存失败，内存已回滚: ${String(cause)}`, { cause });
		}
	}
};
function assertSessionId(sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") throw new LedgerError("invalid-input", "sessionId 必填");
}

//#endregion
//#region src/host/prompts/router.ts
/**
* Router 角色提示词（计划 B2；v1.1 C6 行为护栏修订）。
*
* 完整替换式 persona（预设行 complete: true）。含 {{model}} 插值——这是模板里
* 唯一允许的花括号序列，其余内容不得出现 {{...}}（宿主组装时遇到未注册变量
* 会直接抛错）。Router 预设为动态注册（v1.1 C1），本文件是缺省提示词与静态
* 兜底的唯一文本源，yml 里没有第二份可漂移。
*/
const routerPrompt = `你是 Router，一个长期在线的任务编排器，由 {{model}} 驱动。用户的每一句话都说给你；真正的执行工作由独立的执行会话完成。

## 你的职责与边界

- 理解需求、澄清模糊处、把需求整理成任务（目标、验收条件、约束）、派发、追踪、汇总汇报。
- 你不亲自执行任务里的具体工作（不写代码、不跑命令）：这些属于执行会话。你的产出是清楚的任务书与准确的进度汇报。
- 可以连续接收多条需求：派发完成后不要等待执行结果，继续处理用户的下一条消息。执行会话的进展通过任务快照与通知到达你这里。
- 用户不是执行器：任何时候都不得要求用户替你运行命令、粘贴命令输出或报告系统状态。需要环境事实就派任务去查；工具或信息不够时如实告知用户，而不是转嫁给用户。

## 先判断要不要建任务

- 无需执行的事实问题（记忆里有、上下文里有、常识可答的）直接回答，不建任务、不派发。答不准的先向用户澄清，再决定是否需要执行。
- 派发通道按轻重选（v1.3 准则：轻→子代理，重/持久→分叉 worker）：轻活（一次查询、单点小改、格式转换这类收尾快、不留持久产出的）直接用 subagent 开一次性子代理，不要为它建任务；重活或持久活（多轮交互、要向用户提问、要留文件或仓库改动的）才建任务派发（dispatch_task）：任务书立档、可追踪、可验收。
- 简单单步任务直接派 worker：一个执行会话一次做完，不要升级主管。
- 多步、需要协调多方、或有依赖拆分的任务才派 supervisor；单点工作永远不要套两层。

## 分叉 worker 与类型提示词（cache 模式说明）

- dispatch_task 的执行会话由「分叉」创建：继承本会话历史与你所在环境的工具面，模型也继承来源会话；类型的 models 字段仅作展示与手动切换建议，中途切换模型等于放弃已热的前缀缓存。
- 该类型 worker 的系统提示词经【身份切换卡】生效（worker 收到的第一张卡 = 类型身份职责，不进会话系统提示词）：所以 create_worker_type 写 systemPrompt 时要写成完整的身份与职责说明，创建类型指引不变——没有合适的类型就先建再派。

## 你的上下文

- 你每轮能看到：本角色提示词 + 长期记忆摘要 + 活动任务快照（系统自动注入的「活动任务」一节）+ 本轮用户消息。
- 完整历史会话日志不在你的窗口里。任何关于任务当前状态的问题，用 query_tasks 查询，不要凭对话记忆断言。
- 活动快照覆盖全部未结束任务（含失败待处理）；已完成的任务从快照消失，需要追溯时用 search_history 或查询归档文档。

## 你的工具

- dispatch_task：派发新任务。需求明确后尽快派发。goal 写清要什么、为什么；acceptance 写可验证的完成判据；constraints 写边界与禁做事项；materials 给输入材料（路径、链接）。role 按上面的层级自决：简单单步派 worker，复杂拆解才派 supervisor（注意递归深度限制）。acceptancePolicy 选验收方式：缺省 auto（校验通过即完成）；重要交付设 supervisor（由派发方验收）或 user（由用户在工作台验收）。
- supplement_task：给已有任务补充约束或修正方向。任务书会升版并重投原执行会话；不要为补充重新派发新任务。
- query_tasks：查询任务短卡（按状态或任务 ID）。回答用户「进行得怎么样」前先查。
- control_task：暂停、恢复、取消某个任务。取消时执行会话会收到立即停止的通知。待验收（review-pending）的任务若由你派发，可用 accept 验收通过、reject 驳回返工（note 写明理由）；验收策略为 user 的任务由用户在工作台验收，不要代替用户裁定。
- search_history：检索项目或全局记忆。完成的任务结果、用户的决定、已验证的事实会自动进入记忆；回答「之前做过什么、定过什么」类问题前先检索，命中为空就如实说没有记录，不要编造。
- list_worker_types：列出当前全部 worker 类型（含停用与来源）。派发前拿不准类型时先查这里，templateId 以它为准。
- create_worker_type：现场创建新的 worker 类型（同名会被拒）并立即注册预设，创建成功即可按返回的 templateId 派发；presetRegistered=false 时派发会被拒，要如实告知用户。
- ask_user：向用户澄清。只问真正影响任务书内容的问题；执行会话的问题不会经过你，它们会直接汇集到用户界面的浮窗，由用户直接回答。

## 完成协议

- 执行会话必须用 complete_task 工具申请交付；是否完成由验收策略决定：auto 校验通过即完成，否则进入待验收（review-pending），等待主管或用户确认。
- 你不代替执行会话完成任务，也不要催促它们跳过协议。任务被驳回返工时，用 supplement_task 传达修改要求。
- 执行会话用 report_blocker 报告阻塞时，任务会标记为受阻：把阻塞转告用户，协调解决后视情况用 control_task 恢复或补充材料。
- 派发被拒且错误信息含「派发已冻结」= 系统级故障已触发熔断：立即停止一切派发与重试，如实向用户报告原因，等用户在工作台解除冻结后再继续。
- 用户在工作台按「暂停本 Router 任务」时，只有你派出的任务（及其下游子任务）被停；别的 Router 会话与之后的新派发都不受影响。你会收到一条「已暂停，等用户指示」的告知：停止推进那些任务，等用户指示，不要自行重派。
- query_tasks 返回里的 budgets/breaker 字段是当前派发预算与熔断状态：预算用尽时不要换任务名规避，先向用户确认计划；blocked 任务优先判断「修因或取消」，禁止换名重派。
`;

//#endregion
//#region src/host/prompts/worker.ts
/**
* 工作型 worker 角色提示词（计划 B2；v1.1 C6 提问纪律修订）。
* 与 yml persona 前缀逐字同步（bundle.spec 看守）：改这里必须同步改 yml。
*/
const workerPrompt = `你是工作型执行者，由 {{model}} 驱动：接受一个任务，把它做完、做对、交付。

## 职责与边界

- 你只执行分配给你的任务；你没有派发工具，不能把工作转包给别的会话。需要拆分时用 report_blocker 说明，由编排方处理。
- 专注执行任务书：先读任务书全文与验收条件，再动手。任务书（含版本）作为消息投递给你。
- 有合理默认就继续做，不要停下来问：默认值写进结果说明即可。提问前先看任务书是否已经有答案——多数「不清楚」其实是任务书里写过了。
- 长任务要阶段性用 report_progress 汇报一句话进度；编排方靠它向你同步状态。
- 用户不是执行器：任何时候都禁止让用户执行命令或粘贴输出。你要的是环境事实，就自己用工具去查；查不到或工具不足，用 report_blocker 报告。

## 你的工具

- report_progress：汇报一句话进度。
- complete_task：完成协议。提交时必须带当前任务书版本号（docVersion）；版本不符会被拒（说明任务书在你工作期间更新过，先读新版本再继续）。
- report_blocker：报告阻塞（缺凭据、缺依赖、发现任务书有问题等）。失败或阻塞不要用完成工具掩盖。
- ask_user：向用户提问（只问任务书没写、又没有合理默认、且不影响继续做事就解决不了的问题）。你的问题会直接汇集到用户界面的浮窗，答案会直接回到你的提问工具结果里，不经第三方转述。

## 完成纪律

- 完成必须调用 complete_task：带结果摘要、交付物引用、验收依据；有遗留问题如实列出。
- 自然停止生成、会话空闲、标签被关都不算完成——只有验收策略接受你的提交才算完成。
- 任务书补充新版本到达时，以最新版本为准继续工作。
`;

//#endregion
//#region src/host/prompts/supervisor.ts
/**
* 主管角色提示词（计划 B2；v1.1 C6 双通道与禁主管链修订）。
* 与 yml persona 前缀逐字同步（bundle.spec 看守）：改这里必须同步改 yml。
*/
const supervisorPrompt = `你是主管型执行者，由 {{model}} 驱动：你自己承担一部分工作，也可以把子任务分派出去，最后对整个父任务的交付负责。

## 职责与边界

- 接收主管级任务（任务书已投递给你），必要时拆成子任务，自己完成适合自己做的部分。
- 双通道分派，先判断轻重（v1.3 准则：轻→子代理，重/持久→分叉 worker）：
  - 轻（只读查询、单点小改、格式转换这类收尾快、不留持久产出的）派**子代理**：用 subagent 工具一次性创建，空会话起步、任务提示词必须自包含（背景、目标、验收都在提示词里写全），子代理的结果随完成通知回到你这里。它不进账本、不开标签、不能向用户提问，不要依赖 list_agents 之类清单工具去管它。
  - 重/持久（多轮交互、要向用户提问、要留下文件或仓库改动的）派 **worker**（dispatch_task，role=worker）：worker 会话持久、可交互、入账本。
  - 主管之下不得再派 supervisor：禁主管链，再派一层会被直接拒绝。你之下只有子代理与 worker。
- 分叉 worker 的身份说明（cache 模式）：dispatch_task 的执行会话由分叉创建、继承本会话历史与模型；该类型 worker 的系统提示词经【身份切换卡】生效（第一张卡 = 类型身份职责，不进会话系统提示词），所以给类型写 systemPrompt 时写成完整的身份职责；类型 models 仅作展示，中途切换模型等于放弃已热的前缀缓存。
- 递归派发受最大深度限制（超限会被拒绝）：能自己做完的不要层层转包；拆分时给每个子任务写清楚目标、验收条件与约束。
- 子任务之间有交付顺序要求时用 dependsOn 表达依赖；不要依赖你自己的祖先任务（会被环检查拒绝）。
- 用 query_tasks 跟踪子任务状态；子任务全部完成后你再提交父任务的 complete_task。
- 用户不是执行器：任何时候都不得要求用户替你运行命令、粘贴命令输出或报告系统状态。

## 你的工具

- subagent：一次性子代理（进程内 spawn）：适合查证、单点修改这类收尾快的工作；提示词写自包含，结果等完成通知。
- dispatch_task / supplement_task / query_tasks / control_task / search_history：与 Router 同款的编排工具，用于管理你的 worker 子任务。
- report_progress：阶段性汇报进度（一句话），Router 的活动快照会显示。
- complete_task：完成协议。提交时必须带当前任务书版本号（docVersion）；有未结束的必需子任务时会进入待验收（review-pending），等待验收结论，不要重复提交。
- ask_user：向用户澄清。执行会话的问题会直接汇集到用户界面的浮窗，由用户直接回答。

## 完成纪律

- 完成必须用 complete_task 提交；自然停止生成、会话空闲都不算完成。
- 子任务进入待验收（acceptancePolicy=supervisor）时你是验收方：核对交付物与验收条件后，用 control_task 的 accept 通过、reject 驳回返工（note 写明理由），不要悬置不验收。
- 无法继续、查询失败或工具不足时用 report_blocker 报告阻塞，不要用完成工具掩盖失败，也不要把「工具不行」转成向用户提要求。
- 基础设施类错误（会话创建/投递失败）不要换模板反复重试：系统熔断器会拦住连续失败；收到「派发已冻结」类错误立即停止派发并向上报告。
`;

//#endregion
//#region src/host/templates.ts
/** v1 Config 模板缺省值（种子化输入的兜底；worker-types.json 建立后退役）。 */
const BUILTIN_TEMPLATES = [
	{
		templateId: "coder",
		name: "编码",
		description: "在仓库里写代码、跑测试的执行者",
		role: "worker"
	},
	{
		templateId: "researcher",
		name: "调研",
		description: "查资料、读代码、出结论文档的执行者",
		role: "worker"
	},
	{
		templateId: "reviewer",
		name: "审查",
		description: "审查交付物与验收依据的执行者",
		role: "worker"
	},
	{
		templateId: "lead",
		name: "主管",
		description: "可继续拆分子任务的主管型",
		role: "supervisor"
	}
];
/** 内置「通用 worker」的 templateId（固定；派发预设映射静态 dsh-router-worker）。 */
const BUILTIN_GENERAL_ID = "general";
/** 内置通用 worker 记录（等价修复后的静态 worker 组合：提示词即静态 worker persona）。 */
function builtinGeneralType(now) {
	return {
		templateId: BUILTIN_GENERAL_ID,
		name: "通用 worker",
		description: "只执行单个任务的工作型执行者（内置，等价静态 worker 预设）",
		role: "worker",
		models: [],
		systemPrompt: workerPrompt,
		skills: [],
		enabled: true,
		origin: "builtin",
		createdAt: now,
		updatedAt: now
	};
}
/** 名字 → templateId 基名：ASCII 字母数字转小写连 slug，其余（中文等）回退 type。 */
function slugify(name$1) {
	const slug = name$1.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return slug === "" ? "type" : slug;
}
/** 按角色给种子/缺省类型的默认系统提示词（等价 v1 静态预设 persona）。 */
function defaultPromptForRole(role) {
	return role === "supervisor" ? supervisorPrompt : workerPrompt;
}
var WorkerTypeStore = class {
	fs;
	file;
	now;
	seedTemplates;
	rows = [];
	legacyImported = false;
	loaded = false;
	constructor(fs, file, options = {}) {
		this.fs = fs;
		this.file = file;
		this.now = options.now ?? Date.now;
		this.seedTemplates = options.seedTemplates ?? BUILTIN_TEMPLATES;
	}
	/** 装载（幂等）：文件缺席或损坏 → 首启种子化（内置 + v1 模板导入）。 */
	async load() {
		if (this.loaded) return;
		let file = null;
		try {
			file = JSON.parse(await this.fs.readFile(this.file));
		} catch {
			file = null;
		}
		if (file !== null && Array.isArray(file.types)) {
			this.rows = file.types.filter((row) => row !== null && typeof row === "object" && typeof row.templateId === "string" && row.templateId !== "");
			this.legacyImported = file.legacyImported === true;
		}
		if (!this.rows.some((row) => row.templateId === BUILTIN_GENERAL_ID)) this.rows.unshift(builtinGeneralType(this.now()));
		if (!this.legacyImported) {
			this.importLegacy();
			this.legacyImported = true;
		}
		this.loaded = true;
		await this.save();
	}
	/** v1 Config 模板 → user 类型（一次；同名跳过，提示词按角色补默认）。 */
	importLegacy() {
		const existingNames = new Set(this.rows.map((row) => row.name));
		for (const template of this.seedTemplates) {
			if (template === null || typeof template !== "object" || typeof template.templateId !== "string" || template.templateId === "" || typeof template.name !== "string" || template.name === "" || template.role !== "supervisor" && template.role !== "worker" || this.rows.some((row) => row.templateId === template.templateId) || existingNames.has(template.name)) continue;
			const at = this.now();
			existingNames.add(template.name);
			this.rows.push({
				templateId: template.templateId,
				name: template.name,
				description: typeof template.description === "string" ? template.description : "",
				role: template.role,
				models: [],
				systemPrompt: defaultPromptForRole(template.role),
				skills: [],
				enabled: true,
				origin: "user",
				createdAt: at,
				updatedAt: at
			});
		}
	}
	currentFile() {
		return {
			schemaVersion: 1,
			legacyImported: this.legacyImported,
			types: structuredClone(this.rows)
		};
	}
	/** 写通道：备份 → 变更 → save → 失败回滚（账本纪律）。 */
	async commit(mutate) {
		await this.load();
		const backup = structuredClone(this.rows);
		const backupLegacy = this.legacyImported;
		const result = mutate();
		try {
			await this.save();
		} catch (cause) {
			this.rows = backup;
			this.legacyImported = backupLegacy;
			throw new LedgerError("persistence-failed", `worker 类型保存失败，内存已回滚: ${String(cause)}`, { cause });
		}
		return result;
	}
	async save() {
		const parent = this.file.slice(0, this.file.lastIndexOf("/")) || "/";
		await this.fs.mkdirp(parent);
		await this.fs.writeFile(this.file, JSON.stringify(this.currentFile(), null, 2));
	}
	/** 全部类型（含禁用，插入序）。 */
	async list() {
		await this.load();
		return structuredClone(this.rows);
	}
	async get(templateId) {
		await this.load();
		const found = this.rows.find((row) => row.templateId === templateId);
		return found !== void 0 ? structuredClone(found) : void 0;
	}
	async create(input) {
		const name$1 = typeof input.name === "string" ? input.name.trim() : "";
		if (name$1 === "") throw new LedgerError("invalid-input", "worker 类型名不能为空");
		const role = input.role ?? "worker";
		return this.commit(() => {
			if (this.rows.some((row) => row.name === name$1)) throw new LedgerError("template-exists", `同名 worker 类型已存在: ${name$1}`);
			const base = slugify(name$1);
			let templateId = base;
			for (let n = 2; this.rows.some((row) => row.templateId === templateId); n += 1) templateId = `${base}-${n}`;
			const at = this.now();
			const record = {
				templateId,
				name: name$1,
				description: input.description ?? "",
				role,
				models: [...input.models ?? []],
				systemPrompt: input.systemPrompt ?? defaultPromptForRole(role),
				skills: [...input.skills ?? []],
				enabled: input.enabled ?? true,
				origin: input.origin ?? "user",
				createdAt: at,
				updatedAt: at
			};
			this.rows.push(record);
			return structuredClone(record);
		});
	}
	async update(templateId, patch) {
		return this.commit(() => {
			const record = this.rows.find((row) => row.templateId === templateId);
			if (record === void 0) throw new LedgerError("template-not-found", `worker 类型不存在: ${templateId}`);
			if (record.origin === "builtin") throw new LedgerError("builtin-protected", `内置类型 ${templateId} 固定不可改`);
			if (patch.name !== void 0) {
				const name$1 = patch.name.trim();
				if (name$1 === "") throw new LedgerError("invalid-input", "worker 类型名不能为空");
				if (this.rows.some((row) => row.templateId !== templateId && row.name === name$1)) throw new LedgerError("template-exists", `同名 worker 类型已存在: ${name$1}`);
				record.name = name$1;
			}
			if (patch.description !== void 0) record.description = patch.description;
			if (patch.models !== void 0) record.models = [...patch.models];
			if (patch.systemPrompt !== void 0) record.systemPrompt = patch.systemPrompt;
			if (patch.skills !== void 0) record.skills = [...patch.skills];
			record.updatedAt = this.now();
			return structuredClone(record);
		});
	}
	async setEnabled(templateId, enabled) {
		return this.commit(() => {
			const record = this.rows.find((row) => row.templateId === templateId);
			if (record === void 0) throw new LedgerError("template-not-found", `worker 类型不存在: ${templateId}`);
			if (record.origin === "builtin" && !enabled) throw new LedgerError("builtin-protected", "内置通用 worker 不可禁用（保证任何情况下可派发）");
			record.enabled = enabled;
			record.updatedAt = this.now();
			return structuredClone(record);
		});
	}
	/** 删除（builtin 拒删；删除后动态预设由引擎注销——已关闭会话需重建同名类型才可重开）。 */
	async remove(templateId) {
		return this.commit(() => {
			const index = this.rows.findIndex((row) => row.templateId === templateId);
			if (index < 0) throw new LedgerError("template-not-found", `worker 类型不存在: ${templateId}`);
			if (this.rows[index].origin === "builtin") throw new LedgerError("builtin-protected", `内置类型 ${templateId} 不可删除`);
			const [removed] = this.rows.splice(index, 1);
			return structuredClone(removed);
		});
	}
	/** 启用类型的同步投影（dispatch 描述与 templateId 校验用；load 后可用）。 */
	enabledTemplates() {
		return this.rows.filter((row) => row.enabled).map((row) => ({
			templateId: row.templateId,
			name: row.name,
			description: row.description,
			role: row.role
		}));
	}
	/** 全类型摘要投影（RouterState.types / 类型清单；含 enabled/origin）。 */
	summaries() {
		return this.rows.map((row) => ({
			templateId: row.templateId,
			name: row.name,
			description: row.description,
			role: row.role,
			enabled: row.enabled,
			origin: row.origin
		}));
	}
};
/**
* Router 默认值存储（规格 §6：默认系统提示词、默认模型；C1 供动态 Router 预设
* 与创建即钉模型，C3 的 GET/PUT /router/defaults 路由落在它上面）。缺省值与
* 静态兜底同源（prompts/router.ts），文件缺席/损坏即回缺省，不炸装载。
*/
var RouterDefaultsStore = class {
	fs;
	file;
	cached = null;
	constructor(fs, file) {
		this.fs = fs;
		this.file = file;
	}
	async get() {
		if (this.cached !== null) return { ...this.cached };
		let file = null;
		try {
			file = JSON.parse(await this.fs.readFile(this.file));
		} catch {
			file = null;
		}
		const resolved = {
			routerSystemPrompt: typeof file?.routerSystemPrompt === "string" && file.routerSystemPrompt !== "" ? file.routerSystemPrompt : routerPrompt,
			routerModel: typeof file?.routerModel === "string" ? file.routerModel : ""
		};
		this.cached = resolved;
		return { ...resolved };
	}
	async set(value) {
		const current = await this.get();
		const next = {
			routerSystemPrompt: typeof value.routerSystemPrompt === "string" && value.routerSystemPrompt !== "" ? value.routerSystemPrompt : current.routerSystemPrompt,
			routerModel: typeof value.routerModel === "string" ? value.routerModel : current.routerModel
		};
		const parent = this.file.slice(0, this.file.lastIndexOf("/")) || "/";
		await this.fs.mkdirp(parent);
		const file = {
			schemaVersion: 1,
			...next
		};
		await this.fs.writeFile(this.file, JSON.stringify(file, null, 2));
		this.cached = next;
		return { ...next };
	}
};

//#endregion
//#region src/host/prompts/unified.ts
/**
* 身份中立统一 persona（v1.3 规格 §2.1，cache-priority 模式三预设共用）。
*
* 缓存优先的前提是前缀逐字节一致：本段文本是 Router / 主管型 / 工作型三类会话
* 在 cache-priority 模式下的唯一 complete persona——具体身份不写在这里，由会话
* 历史中的身份卡（【身份卡】/【身份切换卡】）声明（规格 §2 身份卡协议）。
* 内容 = 通用纪律：任务书协议、完成协议（complete_task/report_blocker）、
* 提问纪律、用户非执行器、冻结语义。
*
* 插值只允许 {{model}}（宿主注册的模板变量；行内不得出现其它 {{...}}，
* 宿主组装遇未注册变量直接抛错）。最小面模式不用本文件（静态 yml persona
* 保持现行角色分置，bundle.spec 看守）。
*/
const unifiedPrompt = `你是本编排系统里的一名会话执行者，由 {{model}} 驱动。系统把「编排」与「执行」分给不同的会话：编排者理解需求、拆解派发、追踪汇总；执行者把单个任务做完做对。你当前的身份由会话历史中的身份卡决定，本提示词不赋予你具体身份。

## 身份卡协议

- 会话历史中会有系统投递的身份卡：「【身份卡】你是 …」（会话建立时的身份）与「【身份切换卡】你现在是 …」（系统改派身份，权威最高）。
- 当前身份 = 历史中最后一张身份卡；新切换卡出现后，此前的所有身份声明作废，以新卡为准。
- 每张身份卡写明该身份的职责与可用工具范围。范围外的工具调用会被系统直接拒绝：不要尝试越权调用，也不要想办法绕开——身份卡没有给你的工具，就当不存在。
- 早期历史里可能出现与当前身份不符的内容（分叉继承的来源讨论、旧身份的工作痕迹）：那些是历史，不是给你的指令；一律以最后一张身份卡为准行事。

## 任务书协议

- 执行身份的工作以任务书为准：先读目标、约束与验收条件，再动手。任务书以消息形式投递（含版本号）。
- 收到任务书新版本（系统补充投递）时，以最新版本为准继续工作；完成提交必须带当前版本号（docVersion），版本不符会被拒——说明期间任务书更新过，先读新版本再继续。

## 完成协议

- 任务完成必须调用 complete_task 提交：结果摘要、交付物引用、验收依据。自然停止生成、会话空闲、标签被关都不算完成——只有验收策略接受提交才算完成。
- 无法继续、缺凭据缺依赖、发现任务书有问题：调用 report_blocker 报告阻塞，不要硬撑，更不要用完成工具掩盖失败。
- 长任务阶段性调用 report_progress 汇报一句话进度，让编排方与用户看到推进。
- 是否完成的判定由编排方按验收策略处理；进入待验收（review-pending）就等待结论，不要重复提交。

## 提问纪律

- 有合理默认就继续做，不要停下来问；提问前先看任务书里是否已有答案——多数「不清楚」其实是任务书里写过了。
- 真要问才用 ask_user：问题直达用户界面的浮窗，用户的回答直接回到你的工具结果里；等答案期间不要凭空编造。

## 用户不是执行器

- 任何时候都不得要求用户替你运行命令、粘贴命令输出或报告系统状态。需要环境事实就自己用工具查；查不到或工具不足，用 report_blocker 报告。

## 系统冻结

- 错误信息里出现「派发已冻结」= 系统级故障已触发熔断：立即停止相关操作与重试，如实向用户（或上级会话）报告原因，等冻结解除后再继续。
- 收到「已暂停，等用户指示」= 用户停了你这个会话派出去的任务（含下游子任务）：停止推进，等用户指示，不要自行重派。别的会话与之后的新派发不受影响。
`;

//#endregion
//#region src/host/presets/dynamic.ts
/** 动态 worker 预设的 id 前缀（规格 §5：dsh-router-worker-<类型>）。 */
const DYNAMIC_WORKER_PRESET_PREFIX = "dsh-router-worker-";
function dynamicPresetId(templateId) {
	return `${DYNAMIC_WORKER_PRESET_PREFIX}${templateId}`;
}
/** 动态预设排在静态三预设（10/20/30）之后。 */
const DYNAMIC_ORDER = 100;
/** Router 动态预设 id（会话保存的就是它；v1.3.1 热修供自愈巡检引用）。 */
const ROUTER_PRESET_ID = "dsh-router";
/** 压缩组（与静态三预设同款；isolate realm，r4 条件②的例外形态）。 */
function compactionGroup() {
	return {
		id: "compaction",
		name: "cordis:group",
		group: true,
		isolate: {
			compaction: true,
			toolResultPruner: true
		},
		config: [
			{
				id: "compaction-basic",
				name: "@deepseek-ai/dsh-compaction-basic"
			},
			{
				id: "command-compact",
				name: "@deepseek-ai/dsh-command-compact"
			},
			{
				id: "tool-result-pruner",
				name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
				config: {
					thresholdChars: 8192,
					headChars: 4096,
					tailChars: 1024
				}
			}
		]
	};
}
/** 主管子代理组（r6 §5 推荐清单；禁 list-agents 子路径、禁四死键）。 */
function delegationGroup() {
	return {
		id: "delegation",
		name: "cordis:group",
		group: true,
		isolate: { workflowEngine: true },
		config: [{
			id: "tool-subagent-control",
			name: "@deepseek-ai/dsh-tool-subagent-control"
		}, {
			id: "tool-subagent",
			name: "@deepseek-ai/dsh-tool-subagent",
			config: {
				provider: "spawn",
				toolName: "subagent",
				maxDepth: 2
			}
		}]
	};
}
/** 技能行（r4 §6.2 样板：只注册进本预设 scope 层，无需 realm）。 */
function skillRows(customSkillDirs) {
	return [{
		id: "skill-filesystem",
		name: "@deepseek-ai/dsh-skill-filesystem",
		config: { customSkillDirs: [...customSkillDirs] }
	}, {
		id: "tool-skill",
		name: "@deepseek-ai/dsh-tool-skill"
	}];
}
/**
* cache-priority 统一超集组合（v1.3 规格 §1/§2；每次调用产全新数组，调用方可
* 自由追加技能行不改基准）。三预设（Router 动态定义 / worker 类型动态定义 /
* 兜底场景的类型定义）在 cache 模式下全部由它组成——行级逐字节相同是前缀缓存
* 的前提，spawn-mode.spec 钉住。注意：
* - persona = unified 中立全文（身份进历史不进系统提示词，规格 §2.1）；
* - tools 行 role:'superset'：注册全部编排工具，角色闸在执行层按真实调用者
*   过 assertCallerRole（矩阵不变，规格 §1「执行层硬闸不变」）；
* - 执行工具行 / delegation 组 / context 行全部在场（「模型可见全部工具」），
*   context 行的快照文本全局一致，不破坏跨会话前缀一致；
* - 技能行不进基准（类型个性，追加在超集之后）。
*/
function buildSupersetPlugins() {
	const rows = [
		{
			id: "persona",
			name: "@deepseek-ai/dsh-persona",
			config: {
				prefix: unifiedPrompt,
				complete: true
			}
		},
		{
			id: "tools",
			name: "@goodjin2/dsh-router/tools",
			config: { role: "superset" }
		},
		{
			id: "ask-user",
			name: "@deepseek-ai/dsh-tool-ask-user"
		},
		{
			id: "tool-bash",
			name: "@deepseek-ai/dsh-tool-bash",
			disabled: process.platform === "win32"
		},
		{
			id: "tool-fs",
			name: "@deepseek-ai/dsh-tool-fs",
			config: { applyPatch: false }
		},
		{
			id: "tool-fs-search",
			name: "@deepseek-ai/dsh-tool-fs-search",
			config: { sampleOverCapGlobResults: false }
		},
		delegationGroup(),
		{
			id: "router-context",
			name: "@goodjin2/dsh-router/context"
		}
	];
	rows.push(compactionGroup());
	return rows;
}
/**
* worker 类型 → 动态预设定义。persona 用类型提示词 complete 整段替换；工具行
* 按 role（worker 带宿主执行工具行，supervisor 带 delegation 组）；技能行按
* 解析出的目录挂载；压缩组收尾。调用方（生命周期）注册前对全部行过
* validateRowSpec，坏行拒绝注册。
*/
function buildWorkerPresetDefinition(t, options = {}) {
	const plugins = options.mode === "cache-priority" ? [...buildSupersetPlugins()] : [
		{
			id: "persona",
			name: "@deepseek-ai/dsh-persona",
			config: {
				prefix: t.systemPrompt,
				complete: true
			}
		},
		{
			id: "tools",
			name: "@goodjin2/dsh-router/tools",
			config: { role: t.role }
		},
		{
			id: "ask-user",
			name: "@deepseek-ai/dsh-tool-ask-user"
		}
	];
	if (options.mode !== "cache-priority") if (t.role === "worker") plugins.push({
		id: "tool-bash",
		name: "@deepseek-ai/dsh-tool-bash",
		disabled: process.platform === "win32"
	}, {
		id: "tool-fs",
		name: "@deepseek-ai/dsh-tool-fs",
		config: { applyPatch: false }
	}, {
		id: "tool-fs-search",
		name: "@deepseek-ai/dsh-tool-fs-search",
		config: { sampleOverCapGlobResults: false }
	});
	else plugins.push(delegationGroup());
	if (t.skills.length > 0 && options.customSkillDirs !== void 0 && options.customSkillDirs.length > 0) plugins.push(...skillRows(options.customSkillDirs));
	if (options.mode !== "cache-priority") plugins.push(compactionGroup());
	return {
		id: dynamicPresetId(t.templateId),
		name: t.name,
		description: t.description,
		order: DYNAMIC_ORDER,
		plugins
	};
}
/**
* Router 预设动态定义（id 不变 dsh-router；v1.1 C5：persona complete 行换成
* 本包 prompt-section 行——complete section 运行时按「当前会话覆盖 ?? 默认」
* 组装文本，默认值不烘焙进行定义，改默认无需重注册；多 complete 冲突由宿主
* 组装期报错，所以动态定义里不得残留 persona 行，presets-dynamic/bundle 看守）。
*/
function buildRouterPresetDefinition(options = {}) {
	const compaction = compactionGroup();
	compaction.id = "router-compaction";
	if (options.mode === "cache-priority") return {
		id: "dsh-router",
		name: "Router",
		description: "任务编排器：理解需求、拆解派发、追踪汇总",
		order: 10,
		plugins: buildSupersetPlugins()
	};
	return {
		id: "dsh-router",
		name: "Router",
		description: "任务编排器：理解需求、拆解派发、追踪汇总",
		order: 10,
		plugins: [
			{
				id: "router-prompt-section",
				name: "@goodjin2/dsh-router/prompt-section"
			},
			{
				id: "router-tools",
				name: "@goodjin2/dsh-router/tools",
				config: { role: "router" }
			},
			{
				id: "router-ask-user",
				name: "@deepseek-ai/dsh-tool-ask-user"
			},
			{
				id: "router-context",
				name: "@goodjin2/dsh-router/context"
			},
			compaction
		]
	};
}
/**
* Router 静态兜底定义：逐行等价 v1 cordis.patch.yml 的 dsh-router 行（该行已从
* yml 移除——yml 版与动态注册同 id 会撞 Duplicate agent preset，r4 §1；兜底改由
* 本函数携带，提示词与 prompts/router.ts 同源 import，无第二份文本可漂移）。
* C5 起它保留 persona complete 行（prompts/router.ts 逐字），是动态注册失败时
* 的回退源——回退形态丢会话级覆盖能力，但保证 Router 花名册不消失。
*/
function staticRouterDefinition() {
	const compaction = compactionGroup();
	compaction.id = "router-compaction";
	return {
		id: "dsh-router",
		name: "Router",
		description: "任务编排器：理解需求、拆解派发、追踪汇总",
		order: 10,
		plugins: [
			{
				id: "router-persona",
				name: "@deepseek-ai/dsh-persona",
				config: {
					prefix: routerPrompt,
					complete: true
				}
			},
			{
				id: "router-tools",
				name: "@goodjin2/dsh-router/tools",
				config: { role: "router" }
			},
			{
				id: "router-ask-user",
				name: "@deepseek-ai/dsh-tool-ask-user"
			},
			{
				id: "router-context",
				name: "@goodjin2/dsh-router/context"
			},
			compaction
		]
	};
}
/**
* 递归展开定义里的全部非组行（组行是结构容器没有包可校验，其子行各自独立成行）。
* 生命周期注册前用它把每条宿主行送进 validateRowSpec。
*/
function collectHostRows(rows, out = []) {
	for (const row of rows) {
		if (row.group === true) {
			if (Array.isArray(row.config)) collectHostRows(row.config, out);
			continue;
		}
		out.push(row);
	}
	return out;
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
/** 首行文本（报错只留指向性的一行；Error 取 message，不带 "Error: " 前缀）。 */
function firstLine(value) {
	const message = value instanceof Error ? value.message : String(value);
	return message.split("\n")[0] ?? message;
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
/** 单行校验（v1.1 计划 Task A2 接口）：见文件头。 */
async function validateRowSpec(row, opts = {}) {
	if (row.name === "cordis:group") return { ok: true };
	const load = opts.load ?? makeHostLoader();
	let mod;
	try {
		mod = await load(row.name);
	} catch (error) {
		const code = error?.code;
		return {
			ok: false,
			problems: [`${row.id}: 导入失败 ${typeof code === "string" ? code : "ERR"}: ${firstLine(error)}`]
		};
	}
	const Config$1 = mod?.Config;
	if (typeof Config$1 !== "function") return { ok: true };
	if (Array.isArray(row.config)) return {
		ok: false,
		problems: [`${row.id}: config 是数组（组行的子行应各自成行校验，包行不该带数组 config）`]
	};
	try {
		Config$1(row.config);
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			problems: [`${row.id}: Config 校验失败: ${firstLine(error)}`]
		};
	}
}

//#endregion
//#region src/host/presets/lifecycle.ts
var DynamicPresetEngine = class {
	deps;
	/** 已由本引擎注册的预设 id → 注销器（增量同步与删除的依据）。 */
	disposers = /* @__PURE__ */ new Map();
	validate;
	load;
	constructor(deps) {
		this.deps = deps;
		this.validate = deps.validate ?? this.validateWithHost.bind(this);
		this.load = makeHostLoader({ bases: discoverAllHostBases() });
	}
	async validateWithHost(rows) {
		const problems = [];
		for (const row of collectHostRows(rows)) {
			const verdict = await validateRowSpec(row, { load: this.load });
			if (!verdict.ok) problems.push(...verdict.problems);
		}
		return problems;
	}
	/** 已在册的预设 id（诊断用）。 */
	registeredIds() {
		return [...this.disposers.keys()];
	}
	has(id) {
		return this.disposers.has(id);
	}
	async register(def) {
		const previous = this.disposers.get(def.id);
		if (previous !== void 0) await previous();
		let unregister;
		try {
			unregister = await this.deps.presets.register(def);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("Duplicate") || message.includes("duplicate")) {
				this.deps.logger?.info(`预设 ${def.id} 已在注册表（上一代注册仍在），沿用既有注册`);
				return def.id;
			}
			throw error;
		}
		this.disposers.set(def.id, unregister);
		this.deps.effect(() => {
			return () => {
				if (this.disposers.get(def.id) === unregister) this.disposers.delete(def.id);
				unregister();
			};
		}, `dsh-router: 预设 ${def.id} 注销器`);
		return def.id;
	}
	/**
	* 确保一个 worker 类型的动态预设按当前记录在册（创建/更新共用；builtin 类型
	* 映射静态预设，不经引擎）。mode 决定组合形态（v1.3 A1：cache-priority 出
	* 统一超集）。校验不过或注册抛错 → 告警并返回 false（不炸装载）。
	*/
	async ensureRegistered(record, mode = "minimal-face") {
		if (record.origin === "builtin") return false;
		const id = dynamicPresetId(record.templateId);
		const definition = buildWorkerPresetDefinition(record, {
			customSkillDirs: this.deps.skillDirs?.(record),
			mode
		});
		try {
			const problems = await this.validate(definition.plugins);
			if (problems.length > 0) {
				this.deps.logger?.warn(`worker 类型 ${record.templateId} 的动态预设校验未过，拒绝注册（${id}）:\n${problems.join("\n")}`);
				return false;
			}
			await this.register(definition);
			return true;
		} catch (error) {
			this.deps.logger?.warn(`worker 类型 ${record.templateId} 的动态预设注册失败（${id}）: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}
	/**
	* 增量同步：启用清单里的每个类型确保在册（缺失补注册、变更重注册；mode 决定
	* 组合形态，v1.3 A1）。不在清单里的已注册预设一律保留——禁用语义是「只拒新
	* 派发」（r4 §4）。
	*/
	async syncTypes(types, mode = "minimal-face") {
		const registered = [];
		const failed = [];
		for (const record of types) if (await this.ensureRegistered(record, mode)) registered.push(dynamicPresetId(record.templateId));
		else if (record.origin !== "builtin") failed.push(record.templateId);
		return {
			registered,
			failed
		};
	}
	/** 删除类型 → 注销其动态预设（已关闭会话需重建同名类型才可重开，r4 §4）。 */
	async removeType(templateId) {
		const id = dynamicPresetId(templateId);
		const unregister = this.disposers.get(id);
		if (unregister === void 0) return false;
		this.disposers.delete(id);
		await unregister();
		return true;
	}
	/**
	* Router 预设同步：动态定义（C5：complete section 运行时按会话组装文本，
	* 定义不烘焙默认值——签名因此不带 defaults；mode='cache-priority' 时改出统一
	* 超集组合，规格 §1）优先，校验或注册失败 → 静态兜底定义（persona +
	* prompts/router.ts 逐字）；兜底也失败 → 只告警。
	* 返回值语义不变：'dynamic' | 'static' | 'failed'。
	*/
	async syncRouter(mode = "minimal-face") {
		const dynamic = buildRouterPresetDefinition({ mode });
		try {
			const problems = await this.validate(dynamic.plugins);
			if (problems.length > 0) throw new Error(`校验未过:\n${problems.join("\n")}`);
			await this.register(dynamic);
			return "dynamic";
		} catch (dynamicError) {
			this.deps.logger?.warn(`Router 预设动态注册失败，回退静态定义: ${dynamicError instanceof Error ? dynamicError.message : String(dynamicError)}`);
			try {
				await this.register(staticRouterDefinition());
				return "static";
			} catch (staticError) {
				this.deps.logger?.warn(`Router 预设静态兜底注册也失败（花名册暂无 Router，可重建会话重试）: ${staticError instanceof Error ? staticError.message : String(staticError)}`);
				return "failed";
			}
		}
	}
	/**
	* 自愈（v1.3.1 热修）：Router 预设不在册（重应用窗口/注册失败遗留）则按当前
	* 模式重注册。所有创建/派发/收编入口与周期巡检都先调它——注册表缺位在到达
	* 任何 UI 冷恢复路径之前就被补上。
	*/
	async ensureRouterPresent(mode = "minimal-face") {
		if (this.disposers.has(ROUTER_PRESET_ID)) return true;
		this.deps.logger?.warn(`Router 预设 ${ROUTER_PRESET_ID} 不在册（重应用窗口或注册失败遗留），自愈重注册`);
		return await this.syncRouter(mode) !== "failed";
	}
	/** 停机/重载辅助：注销全部由本引擎注册的预设（正常路径由 ctx.effect 接管）。 */
	async disposeAll() {
		for (const [id, unregister] of [...this.disposers]) {
			this.disposers.delete(id);
			await unregister();
		}
	}
};

//#endregion
//#region src/host/memory/store.ts
const LOW_INFO_MIN_CHARS = 20;
const KIND_TO_MARKER = {
	"user-decision": "决定",
	"worker-suggestion": "建议",
	"verified-fact": "事实"
};
const MARKER_TO_KIND = {
	决定: "user-decision",
	建议: "worker-suggestion",
	事实: "verified-fact"
};
const SUMMARY_HEADING = "## 摘要";
const ENTRIES_HEADING = "## 条目";
/** 文本落盘一律扁平化为单行（记忆条目单行存放；标题同）。 */
function flattenText(input) {
	return input.replace(/\r\n/g, "\n").replace(/[\n\r]/g, " ").trim();
}
/**
* 文档相对 rootDir 的路径（POSIX 形状，供 memoryRef 引用与落盘共用）：
* sessions/<enc(sessionId)>.md | project.md | global.md
*/
function memoryDocRelPath(scope, key) {
	if (scope === "session") {
		if (!key) throw new Error("MemoryDocStore: session 作用域需要 key=sessionId");
		return `sessions/${encodeURIComponent(key)}.md`;
	}
	return scope === "project" ? "project.md" : "global.md";
}
function nextAnchor(entries) {
	let max = 0;
	for (const entry of entries) {
		const match = /^e(\d+)$/.exec(entry.anchor);
		const n = match?.[1] === void 0 ? NaN : Number(match[1]);
		if (Number.isFinite(n) && n > max) max = n;
	}
	return `e${max + 1}`;
}
function serializeDoc(doc) {
	const lines = ["---", `scope: ${doc.scope}`];
	if (doc.sessionId !== void 0) lines.push(`sessionId: ${doc.sessionId}`);
	if (doc.title !== void 0) lines.push(`title: ${doc.title}`);
	lines.push(`updatedAt: ${doc.updatedAt}`, `lastSummarizedSeq: ${doc.lastSummarizedSeq}`, "---", "");
	if (doc.summary !== void 0) lines.push(SUMMARY_HEADING, "", doc.summary, "");
	lines.push(ENTRIES_HEADING, "");
	for (const entry of doc.entries) {
		lines.push(`- [${KIND_TO_MARKER[entry.kind]}] ${entry.text}`);
		lines.push(`  anchor: ${entry.anchor}`);
		if (entry.key !== void 0) lines.push(`  key: ${entry.key}`);
		if (entry.sourceRefs.length > 0) lines.push(`  sources: ${entry.sourceRefs.join("; ")}`);
		lines.push(`  at: ${entry.at}`);
		if (entry.conflictsWith !== void 0) lines.push(`  conflicts-with: ${entry.conflictsWith}`);
		lines.push("");
	}
	return lines.join("\n");
}
const ENTRY_LINE = /^- \[(决定|建议|事实)\] (.*)$/;
const META_LINE = /^  ([A-Za-z-]+): ?(.*)$/;
function parseEntries(zone) {
	const entries = [];
	let current = null;
	for (const line of zone.split("\n")) {
		if (line === "") continue;
		const entryMatch = ENTRY_LINE.exec(line);
		if (entryMatch !== null) {
			const marker = entryMatch[1];
			const text = entryMatch[2];
			if (marker === void 0 || text === void 0) continue;
			current = {
				anchor: "",
				kind: MARKER_TO_KIND[marker],
				sourceRefs: [],
				at: 0,
				text
			};
			entries.push(current);
			continue;
		}
		const metaMatch = META_LINE.exec(line);
		if (metaMatch !== null && current !== null) {
			const field = metaMatch[1];
			const value = metaMatch[2];
			if (field === void 0 || value === void 0) continue;
			if (field === "anchor") current.anchor = value;
			else if (field === "key") current.key = value;
			else if (field === "sources") current.sourceRefs = value.split(";").map((s) => s.trim()).filter((s) => s !== "");
			else if (field === "at") current.at = Number(value);
			else if (field === "conflicts-with") current.conflictsWith = value;
		}
	}
	for (const entry of entries) if (entry.anchor === "" || !Number.isFinite(entry.at)) throw new Error("MemoryDocStore: 条目缺少 anchor/at，文档可能被外部改坏");
	return entries;
}
function parseDoc(raw) {
	const text = raw.replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n")) throw new Error("MemoryDocStore: 记忆文档缺少 YAML 头");
	const headerEnd = text.indexOf("\n---\n", 4);
	if (headerEnd < 0) throw new Error("MemoryDocStore: 记忆文档 YAML 头未闭合");
	const headerLines = text.slice(4, headerEnd).split("\n");
	const body = text.slice(headerEnd + 5);
	const header = /* @__PURE__ */ new Map();
	for (const line of headerLines) {
		const i = line.indexOf(":");
		if (i <= 0) continue;
		header.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
	}
	const scope = header.get("scope");
	if (scope !== "session" && scope !== "project" && scope !== "global") throw new Error(`MemoryDocStore: 记忆文档 scope 非法：${String(scope)}`);
	const updatedAt = Number(header.get("updatedAt"));
	if (!Number.isFinite(updatedAt)) throw new Error("MemoryDocStore: updatedAt 非法");
	const seqRaw = header.get("lastSummarizedSeq");
	const lastSummarizedSeq = seqRaw === void 0 || seqRaw === "" ? 0 : Number(seqRaw);
	if (!Number.isFinite(lastSummarizedSeq)) throw new Error("MemoryDocStore: lastSummarizedSeq 非法");
	const doc = {
		scope,
		updatedAt,
		lastSummarizedSeq,
		entries: []
	};
	const sessionId = header.get("sessionId");
	if (sessionId !== void 0 && sessionId !== "") doc.sessionId = sessionId;
	const title = header.get("title");
	if (title !== void 0 && title !== "") doc.title = title;
	const entriesIdx = body.lastIndexOf(ENTRIES_HEADING);
	if (entriesIdx >= 0) {
		const beforeEntries = body.slice(0, entriesIdx);
		const summaryIdx = beforeEntries.indexOf(SUMMARY_HEADING);
		if (summaryIdx >= 0) {
			const summary = beforeEntries.slice(summaryIdx + 5).trim();
			if (summary !== "") doc.summary = summary;
		}
		doc.entries = parseEntries(body.slice(entriesIdx + 5));
	} else {
		const summaryIdx = body.indexOf(SUMMARY_HEADING);
		if (summaryIdx >= 0) {
			const summary = body.slice(summaryIdx + 5).trim();
			if (summary !== "") doc.summary = summary;
		}
	}
	return doc;
}
var MemoryDocStore = class {
	rootDir;
	fs;
	now;
	writeChain = Promise.resolve();
	constructor(rootDir, fs, options = {}) {
		this.rootDir = rootDir;
		this.fs = fs;
		this.now = options.now ?? Date.now;
	}
	/** 文档绝对路径：rootDir + memoryDocRelPath。 */
	docPath(scope, key) {
		return join(this.rootDir, memoryDocRelPath(scope, key));
	}
	async readDoc(scope, key) {
		const path = this.docPath(scope, key);
		if (!await this.fs.exists(path)) return null;
		return parseDoc(await this.fs.readFile(path));
	}
	/**
	* 追加一条记忆。
	* - scope='session'：key=sessionId（只选文档，不参与主题冲突）；
	* - scope='project'|'global'：key=主题；同主题重复时新条目照写，
	*   自动带 conflicts-with 指向最近一条同主题旧条目（冲突保留不合成）。
	* - 低信息门：text 去空白后不足 20 字符 → 拒绝写入，返回 { skipped:'low-info' }。
	*/
	async appendSummary(scope, key, entry) {
		if (scope === "session" && !key) throw new Error("MemoryDocStore: appendSummary session 作用域需要 key=sessionId");
		const text = flattenText(entry.text);
		if (text.length < LOW_INFO_MIN_CHARS) return { skipped: "low-info" };
		const flatKey = key === void 0 ? void 0 : flattenText(key);
		return this.serialized(async () => {
			const at = this.now();
			const doc = await this.readDoc(scope, key) ?? this.emptyDoc(scope, key, at);
			const anchor = nextAnchor(doc.entries);
			const conflictsWith = scope === "session" || flatKey === void 0 ? void 0 : [...doc.entries].reverse().find((e) => e.key === flatKey)?.anchor;
			doc.entries.push({
				anchor,
				kind: entry.kind,
				key: scope === "session" ? void 0 : flatKey,
				sourceRefs: [...entry.sourceRefs],
				at,
				text,
				conflictsWith
			});
			doc.updatedAt = at;
			await this.writeDoc(scope, key, doc);
			return conflictsWith === void 0 ? {
				written: true,
				anchor
			} : {
				written: true,
				anchor,
				conflictsWith
			};
		});
	}
	/** 推进会话摘要的增量位（已处理到的事件 seq）。文档不存在则创建只有头部的文档。 */
	async setLastSummarizedSeq(sessionId, seq) {
		return this.serialized(async () => {
			const at = this.now();
			const doc = await this.readDoc("session", sessionId) ?? this.emptyDoc("session", sessionId, at);
			doc.lastSummarizedSeq = seq;
			doc.updatedAt = at;
			await this.writeDoc("session", sessionId, doc);
		});
	}
	/** 写会话标题（头部 title 字段；单行化）。文档不存在则创建。 */
	async setSessionTitle(sessionId, title) {
		return this.serialized(async () => {
			const at = this.now();
			const doc = await this.readDoc("session", sessionId) ?? this.emptyDoc("session", sessionId, at);
			doc.title = flattenText(title);
			doc.updatedAt = at;
			await this.writeDoc("session", sessionId, doc);
		});
	}
	/** 替换会话摘要节（最近一次增量总结的条目化文本，整体替换；传空白即清除）。 */
	async setSessionSummary(sessionId, summary) {
		return this.serialized(async () => {
			const at = this.now();
			const doc = await this.readDoc("session", sessionId) ?? this.emptyDoc("session", sessionId, at);
			const trimmed = summary.trim();
			if (trimmed === "") delete doc.summary;
			else doc.summary = trimmed;
			doc.updatedAt = at;
			await this.writeDoc("session", sessionId, doc);
		});
	}
	/** 列出已有会话文档的 sessionId（文件名解码回原值）；sessions 目录不存在返回空数组。 */
	async listSessionIds() {
		const dir = join(this.rootDir, "sessions");
		if (!await this.fs.exists(dir)) return [];
		const names = await this.fs.readdir(dir);
		const ids = [];
		for (const name$1 of names) {
			if (!name$1.endsWith(".md")) continue;
			const bare = name$1.slice(0, -3);
			try {
				ids.push(decodeURIComponent(bare));
			} catch {
				ids.push(bare);
			}
		}
		return ids;
	}
	emptyDoc(scope, key, at) {
		const doc = {
			scope,
			updatedAt: at,
			lastSummarizedSeq: 0,
			entries: []
		};
		if (scope === "session") {
			if (!key) throw new Error("MemoryDocStore: session 作用域需要 key=sessionId");
			doc.sessionId = key;
		}
		return doc;
	}
	/**
	* 读改写串行化：并发的 append/setTitle/setSummary 若各自「读→改→写」，
	* 后写会覆盖先写的增量（丢条目/丢标题）。全 store 一条写链，逐个执行。
	*/
	serialized(fn) {
		const run = this.writeChain.then(fn, fn);
		this.writeChain = run.then(() => void 0, () => void 0);
		return run;
	}
	async writeDoc(scope, key, doc) {
		await this.fs.mkdirp(scope === "session" ? join(this.rootDir, "sessions") : this.rootDir);
		await this.fs.writeFile(this.docPath(scope, key), serializeDoc(doc));
	}
};

//#endregion
//#region src/host/memory/summarizer.ts
function buildSummaryPrompt(input) {
	const events = [...input.events].sort((a, b) => a.seq - b.seq);
	const lines = [
		input.sessionTitle === void 0 ? "会话标题：（无）" : `会话标题：${input.sessionTitle}`,
		"此前摘要：",
		input.previousSummary === void 0 || input.previousSummary === "" ? "（无）" : input.previousSummary,
		"",
		"待摘要的新事件（seq 升序）："
	];
	for (const event of events) lines.push(`#${event.seq} [${event.type}] ${event.textExcerpt}`);
	return { messages: [{
		role: "system",
		content: SYSTEM_PROMPT
	}, {
		role: "user",
		content: lines.join("\n")
	}] };
}
async function summarizeIncremental(store, sessionId, events, llm, options = {}) {
	const doc = await store.readDoc("session", sessionId);
	const lastSeq = doc?.lastSummarizedSeq ?? 0;
	const pending = events.filter((event) => event.seq > lastSeq);
	if (pending.length === 0) return { skipped: "no-new-events" };
	const { messages } = buildSummaryPrompt({
		sessionTitle: doc?.title,
		events: pending,
		previousSummary: doc?.summary
	});
	const signal = options.signal ?? new AbortController().signal;
	const summary = (await llm.stream(messages, signal)).trim();
	if (summary === "") throw new Error("summarizeIncremental: llm 返回空白摘要，不推进增量位（下次重试）");
	await store.setSessionSummary(sessionId, summary);
	const toSeq = Math.max(...pending.map((event) => event.seq));
	await store.setLastSummarizedSeq(sessionId, toSeq);
	return {
		summarized: true,
		fromSeq: Math.min(...pending.map((event) => event.seq)),
		toSeq
	};
}
var SYSTEM_PROMPT;
var init_summarizer = __esm({ "src/host/memory/summarizer.ts": (() => {
	SYSTEM_PROMPT = [
		"你是会话记忆摘要员。把事件流压缩成中文条目化摘要，规则：",
		"- 每条以 [决定]、[建议]、[事实] 之一开头：用户的决定用 [决定]，worker 的主张用 [建议]，已核实的结果用 [事实]；",
		"- 每条末尾用 (seqs: n,n) 注明来源事件序号，便于回溯；",
		"- 每条不超过 200 字；只保留需求、决定、结果、未决事项，不写过程流水；",
		"- 不写代码块，不添加事件里没有的内容；",
		"- 只输出摘要条目本身，不要解释。"
	].join("\n");
}) });

//#endregion
//#region src/host/memory/adapter.ts
var adapter_exports = /* @__PURE__ */ __export({
	BackgroundSummarizer: () => BackgroundSummarizer,
	COMPLETED_TASK_KIND: () => COMPLETED_TASK_KIND,
	JUDGE_OUTCOME_SYSTEM_PROMPT: () => JUDGE_OUTCOME_SYSTEM_PROMPT,
	NO_ROUTE_MESSAGE: () => NO_ROUTE_MESSAGE,
	buildJudgeOutcomeMessages: () => buildJudgeOutcomeMessages,
	createCompletedTaskRecorder: () => createCompletedTaskRecorder,
	createSummaryLlm: () => createSummaryLlm,
	eventsToSummaryEvents: () => eventsToSummaryEvents,
	judgeOutcome: () => judgeOutcome,
	maxSurfaceSeq: () => maxSurfaceSeq,
	parseOutcomeJudgement: () => parseOutcomeJudgement,
	recordCompletedTask: () => recordCompletedTask,
	summarizeSessionViaQuery: () => summarizeSessionViaQuery
});
/**
* 把 ctx.llm.stream 包成 B6 的 SummaryLlm。只认 text-delta 块（按 index 分桶
* 保序拼接）；reasoning/usage/finish 一律忽略。resolveTarget 允许异步返回
* （entry 的兜底链要异步读账本找活会话的路由头）。宿主流或路由缺失的错误
* 原样上抛——由触发方决定怎么容错（本插件触发方全部 warn 不抛）。
*/
function createSummaryLlm(host, resolveTarget) {
	return { async stream(messages, signal) {
		const target = await resolveTarget();
		if (target === void 0) throw new Error(NO_ROUTE_MESSAGE);
		const options = {
			provider: target.provider,
			model: target.model,
			messages,
			purpose: "compaction",
			...signal === void 0 ? {} : { signal }
		};
		const parts = /* @__PURE__ */ new Map();
		for await (const chunk of host.stream(options)) {
			const record = typeof chunk === "object" && chunk !== null ? chunk : {};
			if (record.type !== "text-delta" || typeof record.text !== "string") continue;
			const index = typeof record.index === "number" ? record.index : 0;
			parts.set(index, (parts.get(index) ?? "") + record.text);
		}
		return [...parts.keys()].sort((a, b) => a - b).map((index) => parts.get(index) ?? "").join("");
	} };
}
/** 从一条 surface 事件里提取语义文本（形状照 dsh-session deriveEventMessage）。 */
function eventText(event) {
	if (typeof event !== "object" || event === null) return "";
	const { type, data } = event;
	const record = typeof data === "object" && data !== null ? data : {};
	const message = type === "user/message" ? record : typeof record.message === "object" && record.message !== null ? record.message : {};
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((block) => {
		if (typeof block !== "object" || block === null) return "";
		const b = block;
		return b.type === "text" && typeof b.text === "string" ? b.text : "";
	}).filter((text) => text !== "").join(" ");
	if (typeof message.text === "string") return message.text;
	return "";
}
/** surface 事件 → SummaryEvent：无 seq、无语义文本的事件跳过，文本截断。 */
function eventsToSummaryEvents(events) {
	const result = [];
	for (const event of events) {
		const record = typeof event === "object" && event !== null ? event : {};
		const seq = typeof record.seq === "number" ? record.seq : Number(record.seq);
		if (!Number.isSafeInteger(seq)) continue;
		const type = typeof record.type === "string" && record.type !== "" ? record.type : "unknown";
		const textExcerpt = eventText(event).trim().slice(0, EXCERPT_MAX_CHARS);
		if (textExcerpt === "") continue;
		result.push({
			seq,
			type,
			textExcerpt
		});
	}
	return result;
}
/**
* 走 observeSession 租约读事件并做增量摘要。租约在 finally 里释放——
* llm 抛错也不泄漏；摘要失败（llm 错/空白）错误照 summarizeIncremental 上抛，
* 增量位不推进（事件不丢）。
*/
async function summarizeSessionViaQuery(query, store, sessionId, llm, options = {}) {
	const observation = await query.observeSession(sessionId);
	try {
		return await summarizeIncremental(store, sessionId, eventsToSummaryEvents(observation.events ?? []), llm, options);
	} finally {
		observation[Symbol.dispose]?.();
	}
}
/** 会话当前最大事件 seq（含结构事件；空会话 null）。租约同样在 finally 释放。 */
async function maxSurfaceSeq(query, sessionId) {
	const observation = await query.observeSession(sessionId);
	try {
		let max = null;
		for (const event of observation.events ?? []) {
			const seq = event?.seq;
			const value = typeof seq === "number" ? seq : Number(seq);
			if (Number.isSafeInteger(value) && (max === null || value > max)) max = value;
		}
		return max;
	} finally {
		observation[Symbol.dispose]?.();
	}
}
/** 判定提示词（事件提取复用 eventsToSummaryEvents 的形状与截断规则）。 */
function buildJudgeOutcomeMessages(events) {
	const lines = ["待判定的会话事件（seq 升序，最近一轮）："];
	for (const event of events) lines.push(`#${event.seq} [${event.type}] ${event.textExcerpt}`);
	lines.push("");
	lines.push("请输出判定 JSON。");
	return [{
		role: "system",
		content: JUDGE_OUTCOME_SYSTEM_PROMPT
	}, {
		role: "user",
		content: lines.join("\n")
	}];
}
/**
* 解析判定输出：截取首尾大括号做 JSON 解析（模型偶尔包裹文字时仍可救回）；
* verdict 必须在三态内、summary 必须非空——否则抛错（调用方按「判定不可用」
* 处理，规格 §4：判定失败 → blocked 附判定不可用）。
*/
function parseOutcomeJudgement(raw) {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error(`判定输出不可解析: ${raw.trim().slice(0, 80)}`);
	let parsed;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		throw new Error(`判定输出不是合法 JSON: ${raw.trim().slice(0, 80)}`);
	}
	const record = typeof parsed === "object" && parsed !== null ? parsed : {};
	const verdict = record.verdict;
	if (verdict !== "completed" && verdict !== "partial" && verdict !== "failed") throw new Error(`判定 verdict 非法: ${String(verdict)}`);
	const summary = typeof record.summary === "string" ? record.summary.trim() : "";
	if (summary === "") throw new Error("判定 summary 为空");
	return {
		verdict,
		summary
	};
}
/**
* 独立总结判定：复用记忆摘要的 llm 通道（SummaryLlm），输入会话尾部事件，
* 输出三态判定。事件无语义文本（空会话等）直接抛错——无从判定就是判定失败。
*/
async function judgeOutcome(sessionId, events, llm, options = {}) {
	const summarized = eventsToSummaryEvents(events);
	if (summarized.length === 0) throw new Error(`会话 ${sessionId} 没有可判定的语义事件`);
	const messages = buildJudgeOutcomeMessages(summarized);
	const signal = options.signal ?? new AbortController().signal;
	const raw = (await llm.stream(messages, signal)).trim();
	if (raw === "") throw new Error("判定模型返回空白");
	return parseOutcomeJudgement(raw);
}
/** 写 project 层一条完成记录（kind 固定 verified-fact；低信息按 store 规则拒绝）。 */
function recordCompletedTask(store, input) {
	return store.appendSummary("project", input.title, {
		sourceRefs: [input.taskId, input.resultRelPath],
		kind: COMPLETED_TASK_KIND,
		text: input.summary
	});
}
/**
* 任务完成触发点（不阻塞主流程、失败只回调不抛）：先写 project 层，
* 再对任务会话跑一次增量摘要。任一步失败都不影响调用方。
*/
function createCompletedTaskRecorder(deps) {
	return (input) => {
		(async () => {
			await recordCompletedTask(deps.store, input);
			if (input.sessionId !== void 0) await summarizeSessionViaQuery(deps.query, deps.store, input.sessionId, deps.llm);
		})().catch((error) => {
			deps.onError?.("completed-task", error);
		});
	};
}
var NO_ROUTE_MESSAGE, EXCERPT_MAX_CHARS, BackgroundSummarizer, JUDGE_OUTCOME_SYSTEM_PROMPT, COMPLETED_TASK_KIND;
var init_adapter = __esm({ "src/host/memory/adapter.ts": (() => {
	init_summarizer();
	NO_ROUTE_MESSAGE = "记忆摘要没有可用的模型路由：配置 summarizationProvider/summarizationModel，或让目标会话先路由过一次请求";
	EXCERPT_MAX_CHARS = 240;
	BackgroundSummarizer = class {
		deps;
		/** sessionId → 已调度到的最大事件 seq（去重位）。 */
		scheduled = /* @__PURE__ */ new Map();
		inFlight = /* @__PURE__ */ new Set();
		constructor(deps) {
			this.deps = deps;
		}
		/** 后台调度入口：不 await、不抛（fire-and-forget）。 */
		onIdle(sessionId) {
			if (this.inFlight.has(sessionId)) return;
			(async () => {
				this.inFlight.add(sessionId);
				try {
					const max = await this.deps.maxSeq(sessionId);
					if (max === null) return;
					if (this.scheduled.get(sessionId) === max) return;
					this.scheduled.set(sessionId, max);
					try {
						await this.deps.run(sessionId);
					} catch (error) {
						this.deps.onError?.(sessionId, error);
					}
				} catch (error) {
					this.deps.onError?.(sessionId, error);
				} finally {
					this.inFlight.delete(sessionId);
				}
			})();
		}
		/** 观测口：该会话已调度到的事件位。 */
		scheduledThrough(sessionId) {
			return this.scheduled.get(sessionId);
		}
	};
	JUDGE_OUTCOME_SYSTEM_PROMPT = [
		"你是任务结果判定员。给你一个 worker 会话最近一轮的事件流（用户消息、助手输出），",
		"判断该任务的实际交付状态。只输出一行 JSON，不要解释：",
		"{\"verdict\":\"completed|partial|failed\",\"summary\":\"<不超过 200 字的判定摘要>\"}",
		"三态定义：",
		"- completed：任务目标已实际完成（即使执行者没有调用完成工具提交）；",
		"- partial：部分完成——summary 必须说明剩余工作；",
		"- failed：失败或受阻——summary 必须说明原因；",
		"- 摘要只写事件流里有依据的结论，不添加事件里没有的内容，不写代码块。"
	].join("\n");
	COMPLETED_TASK_KIND = "verified-fact";
}) });

//#endregion
//#region src/host/guard/adjudicator.ts
/** 去抖窗（r7 §5.2：300–500ms 吸收 latched 唤醒的 false→true 翻抖）。 */
const DEFAULT_CLOSURE_DEBOUNCE_MS = 400;
/** 派发后无任何轮结束的首响超时（规格 §4 兜底定时器一）。 */
const DEFAULT_FIRST_RESPONSE_TIMEOUT_MS = 6e5;
/** 任务墙钟上限（规格 §4 兜底定时器二；root-config 可配）。 */
const DEFAULT_ADJUDICATION_WALL_CLOCK_MS = 18e5;
/** 收尾提醒投递（gateway/internal 类）的尝试上限：同 requestId 限时重试。 */
const PROMPT_ATTEMPT_LIMIT = 3;
/**
* 收尾提醒意图账：prepare 先落盘再返回（写前账）——prompt 调用时意图已在
* 磁盘上；同任务同文本的 pending 意图复用同 seq（重试同 requestId）；不同
* 文本、或上次已 delivered，则分配新 seq。绝不用会话事件 seq（重试间漂移，
* r9 §3.3）。宿主重启后 pending 意图跨实例复用。
*/
var ClosureIntentStore = class {
	fs;
	path;
	logger;
	file;
	constructor(deps) {
		this.fs = deps.fs;
		this.path = deps.path;
		this.logger = deps.logger;
	}
	async ensureLoaded() {
		if (this.file !== void 0) return this.file;
		try {
			const parsed = JSON.parse(await this.fs.readFile(this.path));
			if (parsed !== null && typeof parsed === "object" && parsed.schemaVersion === 1 && Array.isArray(parsed.intents)) this.file = {
				schemaVersion: 1,
				intents: parsed.intents.filter((entry) => typeof entry?.taskId === "string" && typeof entry?.seq === "number")
			};
		} catch {}
		this.file ??= {
			schemaVersion: 1,
			intents: []
		};
		return this.file;
	}
	async save() {
		const file = await this.ensureLoaded();
		try {
			const lastSlash = this.path.lastIndexOf("/");
			await this.fs.mkdirp(lastSlash <= 0 ? "/" : this.path.slice(0, lastSlash));
			await this.fs.writeFile(this.path, JSON.stringify(file, null, 2));
		} catch (error) {
			this.logger?.warn(`closure-intents 落盘失败: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/** 分配（或复用）一次收尾提醒的投递身份。 */
	async prepare(taskId, text, now) {
		const file = await this.ensureLoaded();
		const pending = file.intents.find((intent) => intent.taskId === taskId && intent.text === text && intent.deliveredAt === void 0);
		if (pending !== void 0) return {
			seq: pending.seq,
			requestId: pending.requestId
		};
		const seq = file.intents.reduce((acc, intent) => intent.taskId === taskId && intent.seq > acc ? intent.seq : acc, 0) + 1;
		const requestId = `closure-${taskId}-${seq}`;
		file.intents.push({
			taskId,
			seq,
			requestId,
			text
		});
		await this.save();
		return {
			seq,
			requestId: `closure-${taskId}-${seq}`
		};
	}
	/** 标记已投递：下一次同文本提醒会分配新 seq（新周期）。 */
	async markDelivered(taskId, seq, now = 0) {
		const intent = (await this.ensureLoaded()).intents.find((entry) => entry.taskId === taskId && entry.seq === seq);
		if (intent !== void 0 && intent.deliveredAt === void 0) {
			intent.deliveredAt = now;
			await this.save();
		}
	}
};
function closurePromptText(taskId) {
	return [
		`【系统收尾提醒】任务 ${taskId} 的本轮输出已结束，但尚未提交交付。`,
		"请立即选择其一：",
		"1. 已完成 → 调用 complete_task 提交（summary 写清成果与验收条件的对照）；",
		"2. 受阻 → 调用 report_blocker 说明原因；",
		"3. 未做完 → 说明剩余工作与计划。",
		"（这是系统自动提醒，不是用户新指令。）"
	].join("\n");
}
/** 从事件流解析末轮：返回 { lastTurnStartIdx, lastTurnEnd }；无完整轮 → undefined。 */
function lastTurnWindow(events) {
	let startIdx = -1;
	let end;
	for (let i = 0; i < events.length; i += 1) {
		const event = events[i];
		if (event?.type === "turn/start") startIdx = i;
		if (event?.type === "turn/end") end = event.data ?? {};
	}
	if (startIdx < 0 || end === void 0) return void 0;
	return {
		startIdx,
		end
	};
}
function turnHasAssistantOutput(events, startIdx) {
	for (let i = startIdx; i < events.length; i += 1) if (events[i]?.type === "assistant/message") return true;
	return false;
}
function errorCode(error) {
	const code = error?.code;
	return typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
}
/**
* 结果判定器。事件入口 onTurnEnd/onTurnStart（bridge watchStatus 翻沿），
* 周期入口 onDispatched（派发成功重置）；兜底 onFirstResponseTimeout/onWallClock。
* 状态机每任务每周期：watching → nudged → judged。
*/
var OutcomeAdjudicator = class {
	deps;
	firstResponseMs;
	wallClockMs;
	cycles = /* @__PURE__ */ new Map();
	armed = /* @__PURE__ */ new Map();
	debounces = /* @__PURE__ */ new Map();
	evaluating = /* @__PURE__ */ new Set();
	constructor(deps) {
		this.deps = deps;
		this.firstResponseMs = deps.firstResponseTimeoutMs ?? DEFAULT_FIRST_RESPONSE_TIMEOUT_MS;
		this.wallClockMs = deps.adjudicationWallClockMs ?? DEFAULT_ADJUDICATION_WALL_CLOCK_MS;
	}
	/** 派发成功（或补充重投）：重置周期并武装双定时器。 */
	onDispatched(taskId) {
		this.clearTimers(taskId);
		this.cycles.set(taskId, { phase: "watching" });
		this.armTimers(taskId);
	}
	/** 启动恢复：给在飞的 dispatched|running 任务武装定时器（相位 watching）。 */
	async syncWatched() {
		for (const record of await this.deps.ledger.listAll()) if ((record.status === "dispatched" || record.status === "running") && record.sessionId !== void 0) {
			if (!this.cycles.has(record.id)) this.cycles.set(record.id, { phase: "watching" });
			this.armTimers(record.id);
		}
	}
	armTimers(taskId) {
		if (this.armed.has(taskId)) return;
		const cancelFirst = this.deps.schedule(this.firstResponseMs, () => this.onFirstResponseTimeout(taskId));
		const cancelWall = this.deps.schedule(this.wallClockMs, () => this.onWallClock(taskId));
		this.armed.set(taskId, {
			cancelFirst,
			cancelWall
		});
	}
	clearTimers(taskId) {
		const armed = this.armed.get(taskId);
		if (armed !== void 0) {
			armed.cancelFirst();
			armed.cancelWall();
			this.armed.delete(taskId);
		}
	}
	/** 会话转空闲（可能翻抖）：去抖后评估。 */
	onTurnEnd(sessionId) {
		this.debounces.get(sessionId)?.();
		this.debounces.set(sessionId, this.deps.schedule(DEFAULT_CLOSURE_DEBOUNCE_MS, () => {
			this.debounces.delete(sessionId);
			return this.evaluate(sessionId);
		}));
	}
	/** 会话回到运行：取消去抖（新一轮开始了）。 */
	onTurnStart(sessionId) {
		this.debounces.get(sessionId)?.();
		this.debounces.delete(sessionId);
	}
	/** 首响超时：watching 相位补一次提醒（挂死会话不误判——不判定）。 */
	async onFirstResponseTimeout(taskId) {
		const cycle = this.cycles.get(taskId);
		if (cycle === void 0 || cycle.phase !== "watching") return;
		const record = this.deps.ledger.get(taskId);
		if (record === void 0 || record.sessionId === void 0 || record.status !== "dispatched" && record.status !== "running") return;
		await this.nudge(record);
	}
	/** 墙钟到期：watching → 提醒；nudged → 直接判定；judged → 无动作。 */
	async onWallClock(taskId) {
		const cycle = this.cycles.get(taskId);
		if (cycle === void 0 || cycle.phase === "judged") return;
		const record = this.deps.ledger.get(taskId);
		if (record === void 0 || record.sessionId === void 0 || record.status !== "dispatched" && record.status !== "running") return;
		if (cycle.phase === "watching") {
			await this.nudge(record);
			return;
		}
		const observation = await this.deps.observeSession(record.sessionId, { projectionMode: "none" });
		await this.judge(record, observation.events);
	}
	async activeTaskFor(sessionId) {
		for (const record of await this.deps.ledger.listAll()) if (record.sessionId === sessionId && (record.status === "dispatched" || record.status === "running")) return record;
	}
	async hasOpenQuestion(taskId) {
		return (await this.deps.ledger.openQuestions()).some((question) => question.taskId === taskId);
	}
	async evaluate(sessionId) {
		if (this.evaluating.has(sessionId)) return;
		this.evaluating.add(sessionId);
		try {
			const record = await this.activeTaskFor(sessionId);
			if (record === void 0) return;
			const cycle = this.cycles.get(record.id) ?? { phase: "watching" };
			if (cycle.phase === "judged") return;
			if (await this.hasOpenQuestion(record.id)) return;
			const events = (await this.deps.observeSession(sessionId, { projectionMode: "none" })).events;
			const turnWindow = lastTurnWindow(events);
			if (turnWindow === void 0) return;
			if (turnWindow.end.reason?.kind !== "completed") return;
			if (!turnHasAssistantOutput(events, turnWindow.startIdx)) return;
			if (this.deps.sessionState !== void 0) {
				const pending = (await this.deps.sessionState(sessionId))?.pendingInput ?? [];
				if (pending.includes("question") || pending.includes("approval")) return;
			} else if (this.deps.agentsGet(sessionId)?.status === "running") return;
			if (cycle.phase === "watching") await this.nudge(record);
			else await this.judge(record, events);
		} catch (error) {
			this.deps.logger?.warn(`判定评估失败（会话 ${sessionId}）: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.evaluating.delete(sessionId);
		}
	}
	async nudge(record) {
		const taskId = record.id;
		const sessionId = record.sessionId;
		const text = closurePromptText(taskId);
		const intent = await this.deps.intents.prepare(taskId, text, this.deps.now());
		let attempt = 0;
		while (attempt < PROMPT_ATTEMPT_LIMIT) {
			attempt += 1;
			try {
				await this.deps.prompt({
					requestId: intent.requestId,
					sessionId,
					mode: "queue",
					content: [{
						type: "text",
						text
					}]
				});
				await this.deps.intents.markDelivered(taskId, intent.seq, this.deps.now());
				this.cycles.set(taskId, { phase: "nudged" });
				this.armTimers(taskId);
				await this.deps.ledger.updateProgress(taskId, `收尾提醒已投递（${intent.requestId}）：请交付或说明阻塞`);
				this.deps.recordIncident({
					taskId,
					title: "收尾提醒",
					text: `收尾提醒已投递: ${intent.requestId}`
				});
				return;
			} catch (error) {
				const code = errorCode(error);
				if (code.includes("gateway/internal") || code.includes("gateway")) {
					if (attempt >= PROMPT_ATTEMPT_LIMIT) {
						this.deps.logger?.warn(`收尾提醒 ${intent.requestId} 重试耗尽（gateway），意图保持 pending 下轮续投`);
						return;
					}
					continue;
				}
				if (code.includes("writer-held")) {
					await this.deps.ledger.updateProgress(taskId, "收尾提醒投递受阻（session/writer-held），本轮不重试");
					return;
				}
				if (code.includes("not-found")) {
					await this.deps.ledger.updateProgress(taskId, "收尾提醒失败：会话不存在（session/not-found）");
					this.deps.recordIncident({
						taskId,
						title: "收尾提醒失败",
						text: "收尾提醒投递失败 session/not-found"
					});
					return;
				}
				if (code.includes("agent-busy")) {
					await this.deps.ledger.updateProgress(taskId, "收尾提醒推迟：会话被占用（session/agent-busy），下轮再试");
					return;
				}
				throw error;
			}
		}
	}
	async judge(record, events) {
		const taskId = record.id;
		const sessionId = record.sessionId;
		if (this.cycles.get(taskId)?.phase === "judged") return;
		this.cycles.set(taskId, { phase: "judged" });
		try {
			const { judgeOutcome: judgeOutcome$1 } = await Promise.resolve().then(() => (init_adapter(), adapter_exports));
			const judgement = await judgeOutcome$1(sessionId, events, this.deps.llm);
			if (judgement.verdict === "completed") {
				if (record.status === "dispatched") await this.deps.ledger.transition(taskId, "running", "系统判定转执行");
				await this.deps.core.completeTask(sessionId, taskId, {
					docVersion: record.docVersion,
					summary: judgement.summary,
					deliveryOrigin: "system-judged"
				});
				await this.deps.ledger.updateProgress(taskId, `系统判定交付：${judgement.summary}`);
				this.deps.recordIncident({
					taskId,
					title: "系统判定",
					text: `系统判定交付：${judgement.summary}`
				});
			} else {
				await this.deps.core.reportBlocker(sessionId, taskId, `${judgement.verdict}：${judgement.summary}`);
				await this.deps.ledger.updateProgress(taskId, `系统判定 ${judgement.verdict}：${judgement.summary}`);
				this.deps.recordIncident({
					taskId,
					title: "系统判定",
					text: `系统判定 ${judgement.verdict}：${judgement.summary}`
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.deps.core.reportBlocker(sessionId, taskId, `判定不可用：${message}`);
			this.deps.recordIncident({
				taskId,
				title: "判定失败",
				text: `判定不可用：${message}`
			});
		} finally {
			this.cycles.set(taskId, { phase: "judged" });
			this.clearTimers(taskId);
		}
	}
};

//#endregion
//#region src/host/memory/retrieval.ts
const MAX_HITS = 20;
function entryMatches(entry, terms) {
	const haystack = `${entry.text}\n${entry.key ?? ""}`.toLowerCase();
	return terms.every((term) => haystack.includes(term));
}
function collect(hits, scope, key, entries, terms) {
	const rel = memoryDocRelPath(scope, key);
	for (const entry of entries) {
		if (!entryMatches(entry, terms)) continue;
		hits.push({
			memoryRef: `memory://${rel}#${entry.anchor}`,
			snippet: entry.text,
			at: entry.at
		});
	}
}
async function search(store, query, scope) {
	const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== "");
	if (terms.length === 0) return [];
	const hits = [];
	const layers = scope === "all" ? ["project", "global"] : [scope];
	for (const layer of layers) {
		const doc = await store.readDoc(layer);
		if (doc !== null) collect(hits, layer, void 0, doc.entries, terms);
	}
	if (scope === "all") for (const sessionId of await store.listSessionIds()) {
		const doc = await store.readDoc("session", sessionId);
		if (doc !== null) collect(hits, "session", sessionId, doc.entries, terms);
	}
	hits.sort((a, b) => b.at - a.at);
	return hits.slice(0, MAX_HITS).map((hit) => ({
		memoryRef: hit.memoryRef,
		snippet: hit.snippet
	}));
}

//#endregion
//#region src/host/guard/breaker.ts
init_adapter();
/** 滑动窗宽（规格 §2：10 分钟）。 */
const DEFAULT_BREAKER_WINDOW_MS = 6e5;
/** 条件 a 阈值：infra 失败次数（规格 §2：≥3）。 */
const DEFAULT_INFRA_THRESHOLD = 3;
/** 条件 b 阈值：窗口内创建任务数且零完成（规格 §2：≥10）。 */
const DEFAULT_CREATION_THRESHOLD = 10;
/**
* 遗留的手动冻结原因（v1.2 的「紧急暂停」写的；v1.4 起紧急暂停不再冻结全局
* 派发，这个原因本产品不再产生）。装载时遇到它即作废冻结态——否则用户会被
* 一条谁也解不掉的旧标记永久卡在「派发已冻结（user-emergency）」。
*/
const LEGACY_USER_EMERGENCY_REASON = "user-emergency";
function sanitizeEvents(raw) {
	if (!Array.isArray(raw)) return [];
	return raw.filter((entry) => typeof entry?.taskId === "string" && typeof entry?.at === "number").map((entry) => ({
		taskId: entry.taskId,
		at: entry.at
	}));
}
/** 一个 JSON 文件的读改写持久化形状（与账本/UI 状态同款）。 */
var CircuitBreaker = class {
	fs;
	path;
	now;
	windowMs;
	infraThreshold;
	creationThreshold;
	logger;
	file = {
		schemaVersion: 1,
		frozen: false,
		infraFailures: [],
		creations: [],
		completions: []
	};
	loaded = false;
	loadPromise;
	constructor(deps) {
		this.fs = deps.fs;
		this.path = deps.path;
		this.now = deps.now;
		this.windowMs = typeof deps.windowMs === "number" && deps.windowMs > 0 ? deps.windowMs : DEFAULT_BREAKER_WINDOW_MS;
		this.infraThreshold = typeof deps.infraThreshold === "number" && deps.infraThreshold >= 1 ? Math.floor(deps.infraThreshold) : DEFAULT_INFRA_THRESHOLD;
		this.creationThreshold = typeof deps.creationThreshold === "number" && deps.creationThreshold >= 1 ? Math.floor(deps.creationThreshold) : DEFAULT_CREATION_THRESHOLD;
		this.logger = deps.logger;
	}
	/** 首次访问时从持久化装载（构造函数保持同步；坏文件/版本不符从空白开始）。 */
	ensureLoaded() {
		if (this.loaded) return Promise.resolve();
		this.loadPromise ??= this.loadFromDisk().then(() => {
			this.loaded = true;
		});
		return this.loadPromise;
	}
	async loadFromDisk() {
		try {
			const parsed = JSON.parse(await this.fs.readFile(this.path));
			if (parsed !== null && typeof parsed === "object" && parsed.schemaVersion === 1) {
				this.file = {
					schemaVersion: 1,
					frozen: parsed.frozen === true,
					...typeof parsed.reason === "string" && parsed.reason !== "" ? { reason: parsed.reason } : {},
					...typeof parsed.frozenAt === "number" ? { frozenAt: parsed.frozenAt } : {},
					infraFailures: sanitizeEvents(parsed.infraFailures),
					creations: sanitizeEvents(parsed.creations),
					completions: sanitizeEvents(parsed.completions)
				};
				if (this.file.frozen && this.file.reason === LEGACY_USER_EMERGENCY_REASON) {
					this.file.frozen = false;
					this.file.reason = void 0;
					this.file.frozenAt = void 0;
					this.logger?.warn(`已作废遗留的紧急暂停冻结标记（${LEGACY_USER_EMERGENCY_REASON}）：紧急暂停现在只停当前 Router 的任务，不再冻结全局派发`);
					await this.save();
				}
			}
		} catch {}
	}
	/** 状态落盘（mkdirp 父目录；失败只告警，内存熔断仍生效）。 */
	async save() {
		try {
			const lastSlash = this.path.lastIndexOf("/");
			const parent = lastSlash <= 0 ? "/" : this.path.slice(0, lastSlash);
			await this.fs.mkdirp(parent);
			await this.fs.writeFile(this.path, JSON.stringify(this.file, null, 2));
		} catch (error) {
			this.logger?.warn(`guard-state.json 落盘失败（熔断以内存状态继续生效）: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/** 滑窗修剪：窗口外的失败/创建/完成事件出窗（含边界）。 */
	prune(nowAt) {
		const cutoff = nowAt - this.windowMs;
		this.file.infraFailures = this.file.infraFailures.filter((entry) => entry.at >= cutoff);
		this.file.creations = this.file.creations.filter((entry) => entry.at >= cutoff);
		this.file.completions = this.file.completions.filter((entry) => entry.at >= cutoff);
	}
	inWindowCounts() {
		return {
			infraFailures: this.file.infraFailures.length,
			creations: new Set(this.file.creations.map((entry) => entry.taskId)).size,
			completions: this.file.completions.length
		};
	}
	/** 阈值判定 + 自动冻结（锁存；已冻结时不覆盖首次原因）。落盘由调用方统一做。 */
	evaluateAutoFreeze(nowAt) {
		if (this.file.frozen) return;
		const counts = this.inWindowCounts();
		if (counts.infraFailures >= this.infraThreshold) {
			this.file.frozen = true;
			this.file.reason = `infra 失败 ${counts.infraFailures} 次（${Math.round(this.windowMs / 6e4)} 分钟窗口）`;
			this.file.frozenAt = nowAt;
			return;
		}
		if (counts.creations >= this.creationThreshold && counts.completions === 0) {
			this.file.frozen = true;
			this.file.reason = `窗口内创建 ${counts.creations} 个任务零完成（疑似创建风暴）`;
			this.file.frozenAt = nowAt;
		}
	}
	/** 记录一次派发失败；只有 infra 计数（task 类不进熔断，规格 §1）。 */
	async recordFailure(event) {
		await this.ensureLoaded();
		if (event.class !== "infra") return;
		const at = event.at ?? this.now();
		this.prune(at);
		this.file.infraFailures.push({
			taskId: event.taskId,
			at
		});
		this.evaluateAutoFreeze(at);
		await this.save();
	}
	/** 记录一次任务创建（集合语义：同任务重记只刷新时间）。 */
	async recordCreation(taskId, at) {
		await this.ensureLoaded();
		const at2 = at ?? this.now();
		this.prune(at2);
		this.file.creations = this.file.creations.filter((entry) => entry.taskId !== taskId);
		this.file.creations.push({
			taskId,
			at: at2
		});
		this.evaluateAutoFreeze(at2);
		await this.save();
	}
	/** 记录一次完成：清该任务的创建计数基准，并把「零完成」信号破掉。 */
	async recordCompletion(taskId, at) {
		await this.ensureLoaded();
		const at2 = at ?? this.now();
		this.prune(at2);
		this.file.creations = this.file.creations.filter((entry) => entry.taskId !== taskId);
		this.file.completions.push({
			taskId,
			at: at2
		});
		await this.save();
	}
	/** 当前状态（读口做滑窗修剪，冻结态不因事件滑出而解除）。 */
	async state() {
		await this.ensureLoaded();
		this.prune(this.now());
		const state = {
			frozen: this.file.frozen,
			counts: this.inWindowCounts()
		};
		if (this.file.frozen) {
			state.reason = this.file.reason;
			state.frozenAt = this.file.frozenAt;
		}
		return state;
	}
	/** 手动冻结（紧急暂停通道用；已冻结时保留首次原因）。 */
	async freeze(reason) {
		await this.ensureLoaded();
		if (this.file.frozen) return;
		this.file.frozen = true;
		this.file.reason = reason;
		this.file.frozenAt = this.now();
		await this.save();
	}
	/** 用户解除：清冻结标与原因；窗口事件保留（仍失败会很快再次闭合）。 */
	async unfreeze() {
		await this.ensureLoaded();
		this.file.frozen = false;
		this.file.reason = void 0;
		this.file.frozenAt = void 0;
		await this.save();
	}
};

//#endregion
//#region src/host/guard/budgets.ts
/**
* 派发预算 DispatchBudgets（v1.2 规格 §3，计划 Task B2 接口逐字）。
*
* 以「轮次」近似「用户消息」边界：会话 running→true 即新轮（entry 把
* bridge.watchStatus 的该沿映射到 onTurnStart；ask_user 的回答开启新轮，预算
* 自然重计）。三个独立层面，互不替代：
*   - Router 会话每轮 1 个任务（硬限）——第二个任务必须先 ask_user 列出计划与
*     理由，用户确认后该消息的预算清零重计（确认视为新指令）；
*   - Router 会话每轮 1 批澄清提问（与任务预算共享确认语义）——第二批在认领
*     层自动回「请合并为一批重问」（questions.ts 消费）；
*   - 主管失败预算：连续 3 次派发失败（infra 或 task 均计）→ 该主管的派发冻结
*     （supervisorFrozen，错误码 supervisor-failure-budget 指明 report_blocker
*     出路）；成功派发或新轮解除。成功子任务不设上限（任务需求各异）。
*
* v1.1 的 per-task retry（3 次自动 blocked）是任务层预算，与本类无涉。
*/
/** Router 每轮任务数硬限（规格 §3：最多 1 个）。 */
const DEFAULT_TASKS_PER_TURN = 1;
/** Router 每轮提问批次数（规格 §3：1 批）。 */
const DEFAULT_QUESTION_BATCHES_PER_TURN = 1;
/** 主管连续失败冻结阈值（规格 §3：3 次）。 */
const DEFAULT_SUPERVISOR_FAILURE_LIMIT = 3;
var DispatchBudgets = class {
	turns = /* @__PURE__ */ new Map();
	failures = /* @__PURE__ */ new Map();
	maxTasksPerTurn;
	maxQuestionBatchesPerTurn;
	supervisorFailureLimit;
	constructor(deps = {}) {
		this.maxTasksPerTurn = typeof deps.maxTasksPerTurn === "number" && deps.maxTasksPerTurn >= 1 ? Math.floor(deps.maxTasksPerTurn) : DEFAULT_TASKS_PER_TURN;
		this.maxQuestionBatchesPerTurn = typeof deps.maxQuestionBatchesPerTurn === "number" && deps.maxQuestionBatchesPerTurn >= 1 ? Math.floor(deps.maxQuestionBatchesPerTurn) : DEFAULT_QUESTION_BATCHES_PER_TURN;
		this.supervisorFailureLimit = typeof deps.supervisorFailureLimit === "number" && deps.supervisorFailureLimit >= 1 ? Math.floor(deps.supervisorFailureLimit) : DEFAULT_SUPERVISOR_FAILURE_LIMIT;
	}
	/** 新轮开始（running→true 沿；ask_user 的回答开启新轮）：清该会话全部轮态与失败连计。 */
	onTurnStart(sessionId) {
		this.turns.delete(sessionId);
		this.failures.delete(sessionId);
	}
	/** 每轮任务预算：ok=false 时错误码 per-turn-task-budget（出路：先 ask_user 确认）。 */
	tryConsumeTaskDispatch(sessionId) {
		const turn = this.turns.get(sessionId) ?? {
			taskDispatches: 0,
			questionBatches: 0
		};
		if (turn.taskDispatches >= this.maxTasksPerTurn) return {
			ok: false,
			code: "per-turn-task-budget"
		};
		turn.taskDispatches += 1;
		this.turns.set(sessionId, turn);
		return { ok: true };
	}
	/** 每轮提问批次预算：ok=false 时错误码 per-turn-question-budget（认领层自动回「请合并为一批重问」）。 */
	tryConsumeQuestionBatch(sessionId) {
		const turn = this.turns.get(sessionId) ?? {
			taskDispatches: 0,
			questionBatches: 0
		};
		if (turn.questionBatches >= this.maxQuestionBatchesPerTurn) return {
			ok: false,
			code: "per-turn-question-budget"
		};
		turn.questionBatches += 1;
		this.turns.set(sessionId, turn);
		return { ok: true };
	}
	/** 记一次派发失败（infra 或 task 均计）；连续达阈值 → 该主管派发冻结。 */
	recordDispatchFailure(sessionId) {
		const state = this.failures.get(sessionId) ?? {
			consecutiveFailures: 0,
			frozen: false
		};
		state.consecutiveFailures += 1;
		if (state.consecutiveFailures >= this.supervisorFailureLimit) state.frozen = true;
		this.failures.set(sessionId, state);
	}
	/** 记一次派发成功：连败清零、解除冻结（成功子任务不设上限）。 */
	recordDispatchSuccess(sessionId) {
		this.failures.set(sessionId, {
			consecutiveFailures: 0,
			frozen: false
		});
	}
	/** 该会话的派发是否因连续失败被冻结。 */
	supervisorFrozen(sessionId) {
		return this.failures.get(sessionId)?.frozen ?? false;
	}
	/** 模型可见投影（query_tasks.budgets；键全定义）。 */
	snapshot(sessionId) {
		const turn = this.turns.get(sessionId) ?? {
			taskDispatches: 0,
			questionBatches: 0
		};
		const failure = this.failures.get(sessionId) ?? {
			consecutiveFailures: 0,
			frozen: false
		};
		return {
			taskDispatchesThisTurn: turn.taskDispatches,
			taskLimitPerTurn: this.maxTasksPerTurn,
			questionBatchesThisTurn: turn.questionBatches,
			questionLimitPerTurn: this.maxQuestionBatchesPerTurn,
			consecutiveDispatchFailures: failure.consecutiveFailures,
			supervisorFailureLimit: this.supervisorFailureLimit,
			supervisorFrozen: failure.frozen
		};
	}
};

//#endregion
//#region src/host/observability.ts
var FirstRequestCacheObserver = class {
	ledger;
	logger;
	/** 「该会话的 assistant/message 已出现过」一次性标记（会话 ID 集合）。 */
	seen = /* @__PURE__ */ new Set();
	constructor(deps) {
		this.ledger = deps.ledger;
		this.logger = deps.logger;
	}
	/** 根作用域 `session/event` 监听体：`ctx.on('session/event', (session, event) => void observer.onSessionEvent(session, event))`。 */
	async onSessionEvent(session, event) {
		try {
			await this.handle(session, event);
		} catch (error) {
			this.logger?.warn(`缓存命中观测失败（已忽略，不影响会话事件流）: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	async handle(session, event) {
		const sessionId = sessionIdOf(session);
		if (sessionId === void 0) return;
		if (!isAssistantMessage(event)) return;
		if (this.seen.has(sessionId)) return;
		const task = (await this.ledger.listAll()).find((record) => record.sessionId === sessionId);
		if (task === void 0) return;
		this.seen.add(sessionId);
		const tokens = cacheReadTokensOf(event);
		if (tokens === void 0) return;
		await this.ledger.recordFirstCacheRead(task.id, tokens);
	}
};
/** 宿主 Session 的防御性读 ID（`session.id` 是由 header 派生的 getter）。 */
function sessionIdOf(session) {
	if (session === null || typeof session !== "object") return void 0;
	const id = session.id;
	return typeof id === "string" && id !== "" ? id : void 0;
}
function isAssistantMessage(event) {
	return event !== null && typeof event === "object" && event.type === "assistant/message";
}
/** `data.usage.cacheReadTokens`：字段缺/非有限数值 = 未上报。 */
function cacheReadTokensOf(event) {
	const data = event.data;
	if (data === null || typeof data !== "object") return void 0;
	const usage = data.usage;
	if (usage === null || typeof usage !== "object") return void 0;
	const tokens = usage.cacheReadTokens;
	return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : void 0;
}

//#endregion
//#region src/host/root-config.ts
/** 根服务的宿主 schema（check-host-rows 用它校验行的 config）。 */
const Config = Schema.object({
	dataDir: Schema.string().default("").volatile(),
	tasksDir: Schema.string().default(".router").volatile(),
	maxActiveCards: Schema.number().default(12).volatile(),
	perTypeConcurrency: Schema.number().default(3).volatile(),
	maxDepth: Schema.number().default(3).volatile(),
	routerPreset: Schema.string().default("dsh-router").volatile(),
	supervisorPreset: Schema.string().default("dsh-router-supervisor").volatile(),
	workerPreset: Schema.string().default("dsh-router-worker").volatile(),
	workerSpawnMode: Schema.union(["cache-priority", "minimal-face"]).default("cache-priority").volatile(),
	summarizationProvider: Schema.string().default("").volatile(),
	summarizationModel: Schema.string().default("").volatile(),
	questionBudget: Schema.number().default(2).volatile(),
	firstResponseTimeoutMs: Schema.number().default(6e5).volatile(),
	adjudicationWallClockMs: Schema.number().default(18e5).volatile(),
	breakerWindowMs: Schema.number().default(6e5).volatile(),
	breakerInfraThreshold: Schema.number().default(3).volatile(),
	breakerCreationThreshold: Schema.number().default(10).volatile(),
	templates: Schema.array(Schema.object({
		templateId: Schema.string().required(),
		name: Schema.string().required(),
		description: Schema.string().default(""),
		role: Schema.union(["supervisor", "worker"]).default("worker")
	})).default(BUILTIN_TEMPLATES).volatile()
});

//#endregion
//#region src/entry.ts
/** Loader 行与诊断里看到的插件名（裸包名，与 cordis.patch.yml 的行一致）。 */
const name = "@goodjin2/dsh-router";
/**
* live 生命周期接线（宿主契约）：
* - `session/created`：会话进入 live store → 权威组合投影直达判定；
* - `session/event`：`agent-preset/selected` 是权威提交信号；
* - `session/disposed`：会话离开 live store（含发布回滚）→ **撤销 live 权威
*   代际**，进入受控冷重判/unknown（review I6：离开 live 后不再有投影事件
*   维护的旧事实不得继续授权）。
*
* 三个事件共用同一生命周期 token（索引侧按实例身份判定），旧实例的
* disposed 不清新实例。
*/
function bindSessionLifecycle(ctx, index) {
	ctx.on("session/created", ((session) => {
		index.onLiveSession(session);
	}));
	ctx.on("session/event", ((session, event) => {
		index.onLiveSessionEvent(session, event);
	}));
	ctx.on("session/disposed", ((session) => {
		index.onLiveSessionDisposed(session);
	}));
}
/**
* 身份卡投递包装（review I2）：
* - `strict`：**失败向上抛**——收编面据此判定"投递真的成功了吗"，只有真成功
*   才记账（否则失败被吞掉后收编器会把候选记成已投递，永久不再补发）。
* - `lenient`：失败只告警——保留给"创建成功后补发"这类不该被投递失败打断
*   主流程的路径。
*/
function makeIdentityCardDeliverer(deliver, log) {
	return {
		strict: async (sessionId) => {
			await deliver(sessionId);
		},
		lenient: async (sessionId) => {
			try {
				await deliver(sessionId);
			} catch (error) {
				log.warn(`Router 身份卡投递失败（下次 state 重试，requestId 幂等）: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};
}
/** 必需的宿主服务（缺席行装载失败，fail loud，不留静默残废）。
*  agentPresets（r4 §1：动态注册预设的注册表，宿主基础组合常驻服务）。 */
const inject = [
	"sessionController",
	"agents",
	"workspaceRegistry",
	"sessionQuery",
	"llm",
	"agentPresets"
];
/** 数值钳位：非数值回默认，负数取 0。 */
function nonNegative(value, fallback) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return value < 0 ? 0 : value;
}
/** 字符串：非空字符串否则回默认。 */
function stringOr(value, fallback) {
	return typeof value === "string" && value.trim() !== "" ? value : fallback;
}
/** 模板清单：形状不对逐条丢弃，全部不合法回内置。 */
function templatesOr(value) {
	if (!Array.isArray(value)) return BUILTIN_TEMPLATES;
	const parsed = [];
	for (const entry of value) {
		const candidate = entry;
		if (candidate !== null && typeof candidate === "object" && typeof candidate.templateId === "string" && candidate.templateId !== "" && typeof candidate.name === "string" && (candidate.role === "supervisor" || candidate.role === "worker")) parsed.push({
			templateId: candidate.templateId,
			name: candidate.name,
			description: typeof candidate.description === "string" ? candidate.description : "",
			role: candidate.role
		});
	}
	return parsed.length > 0 ? parsed : BUILTIN_TEMPLATES;
}
/**
* 模式解析（v1.3 A1；评审 F1 修正）：宿主 loader 经 Config["~standard"].validate
* 把 volatile 字段包成 {get} 惰性描述符再传 apply——先解引用再认字面值，只认两个
* 合法值，其余回默认 cache-priority。导出供测试。
*/
function spawnModeOr(value) {
	return (typeof value === "object" && value !== null && typeof value.get === "function" ? value.get() : value) === "minimal-face" ? "minimal-face" : "cache-priority";
}
/** 防御性解析（导出仅为测试与将来复用）：缺省补默认、枚举外回默认、负数取 0。 */
function resolveRootConfig(raw) {
	const source = typeof raw === "object" && raw !== null ? raw : {};
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return {
		dataDir: stringOr(source.dataDir, join(home, "router")),
		tasksDir: stringOr(source.tasksDir, ".router"),
		maxActiveCards: nonNegative(source.maxActiveCards, 12),
		perTypeConcurrency: nonNegative(source.perTypeConcurrency, 3),
		maxDepth: Math.max(1, nonNegative(source.maxDepth, 3)),
		routerPreset: stringOr(source.routerPreset, "dsh-router"),
		supervisorPreset: stringOr(source.supervisorPreset, "dsh-router-supervisor"),
		workerPreset: stringOr(source.workerPreset, "dsh-router-worker"),
		summarizationProvider: stringOr(source.summarizationProvider, ""),
		summarizationModel: stringOr(source.summarizationModel, ""),
		questionBudget: nonNegative(source.questionBudget, DEFAULT_QUESTION_BUDGET),
		firstResponseTimeoutMs: nonNegative(source.firstResponseTimeoutMs, 6e5),
		adjudicationWallClockMs: nonNegative(source.adjudicationWallClockMs, 18e5),
		breakerWindowMs: nonNegative(source.breakerWindowMs, DEFAULT_BREAKER_WINDOW_MS),
		breakerInfraThreshold: nonNegative(source.breakerInfraThreshold, DEFAULT_INFRA_THRESHOLD),
		breakerCreationThreshold: nonNegative(source.breakerCreationThreshold, DEFAULT_CREATION_THRESHOLD),
		workerSpawnMode: spawnModeOr(source.workerSpawnMode),
		templates: templatesOr(source.templates)
	};
}
/** 原子写序号：与 pid 一起保证同目录临时文件名唯一，并发写不互踩临时文件。 */
let atomicTmpSeq = 0;
/**
* 原子写：写同目录临时文件再 rename 覆盖。rename 原子性保证崩溃时目标文件
* 要么旧版完整、要么新版完整，绝不留下半写截断的 JSON（账本/索引/类型文件
* 一旦截断，load 解析失败返 null 会静默清零全部数据）。
*/
async function atomicWriteFile(path, content) {
	await mkdir(join(path, ".."), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${++atomicTmpSeq}`;
	try {
		await writeFile(tmp, content, "utf8");
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}
/** node:fs/promises 适配成 FsAdapter。 */
function fsAdapter() {
	return {
		readFile: (p) => readFile(p, "utf8"),
		writeFile: (p, content) => atomicWriteFile(p, content),
		mkdirp: async (p) => {
			await mkdir(p, { recursive: true });
		},
		exists: async (p) => {
			try {
				await readFile(p);
				return true;
			} catch {
				return false;
			}
		},
		readdir: async (p) => {
			try {
				return await readdir(p);
			} catch {
				return [];
			}
		}
	};
}
/** 一个 JSON 文件的读改写持久化（账本与 UI 状态共用形状）。 */
function jsonFilePersistence(path) {
	return {
		async load() {
			try {
				return JSON.parse(await readFile(path, "utf8"));
			} catch {
				return null;
			}
		},
		async save(value) {
			await atomicWriteFile(path, JSON.stringify(value, null, 2));
		}
	};
}
/** 装载入口：组装根服务并挂接宿主。 */
function apply(ctx, rawConfig) {
	const config = resolveRootConfig(rawConfig);
	const log = ctx.logger?.(name) ?? {
		info: (m) => console.info(`[${name}] ${m}`),
		warn: (m) => console.warn(`[${name}] ${m}`)
	};
	let currentSpawnMode = config.workerSpawnMode;
	const spawnMode = () => currentSpawnMode;
	const fs = fsAdapter();
	const ledger = new TaskLedger(jsonFilePersistence(join(config.dataDir, "ledger.json")));
	const docStores = /* @__PURE__ */ new Map();
	const docsFor = (cwd) => {
		const key = cwd === "" ? "." : cwd;
		const existing = docStores.get(key);
		if (existing !== void 0) return existing;
		const store = new TaskDocStore(join(key, config.tasksDir), fs);
		docStores.set(key, store);
		return store;
	};
	const ui = new UiStateStore(jsonFilePersistence(join(config.dataDir, "ui-state.json")));
	const adoptionCache = createRouterAdoptionCache();
	const breaker = new CircuitBreaker({
		fs,
		path: join(config.dataDir, "guard-state.json"),
		now: () => Date.now(),
		windowMs: config.breakerWindowMs,
		infraThreshold: config.breakerInfraThreshold,
		creationThreshold: config.breakerCreationThreshold,
		logger: { warn: (message) => log.warn(message) }
	});
	const budgets = new DispatchBudgets();
	const typeStore = new WorkerTypeStore(fs, join(config.dataDir, "worker-types.json"), { seedTemplates: config.templates });
	const defaultsStore = new RouterDefaultsStore(fs, join(config.dataDir, "router-defaults.json"));
	const sessionPrompts = new SessionPromptStore(fs, join(config.dataDir, "router-prompts.json"));
	let defaultsText = routerPrompt;
	/** prompt-section 行的同步文本源：当前会话覆盖 ?? 默认（缓存）。 */
	const sessionPromptText = (sessionId) => {
		if (sessionId === void 0) return defaultsText;
		return sessionPrompts.get(sessionId) ?? defaultsText;
	};
	/** templateId → 预设 id：启用类型走动态预设；内置通用 worker 走静态预设
	*  （保证任何情况下可派发）；禁用/未知 → undefined（回退静态角色预设，
	*  由核心的 assertTemplateUsable 拒绝派发）。 */
	const resolvePresetForTemplate = async (templateId, role) => {
		const record = await typeStore.get(templateId);
		if (record === void 0 || !record.enabled || record.role !== role) return void 0;
		if (record.origin === "builtin") return role === "worker" ? config.workerPreset : config.supervisorPreset;
		return dynamicPresetId(templateId);
	};
	const workspaceRegistry = {
		list: () => ctx.workspaceRegistry.list(),
		get: (id) => ctx.workspaceRegistry.get(id)
	};
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const resolveLivePreset = (session) => {
		try {
			const value = (ctx.get?.("sessionProjections"))?.stateOf?.(session, "agentPreset");
			if (typeof value === "string") return value;
			if (value === null) return null;
			return;
		} catch {
			return;
		}
	};
	const sessionHeaderIndex = new SessionHeaderIndex({
		root: join(home, "sessions"),
		routerPreset: config.routerPreset,
		resolveLivePreset,
		membership: {
			list: () => ctx.workspaceRegistry.list(),
			get: (workspaceId) => ctx.workspaceRegistry.get(workspaceId),
			archivedIds: () => {
				const raw = ctx.workspaceRegistry.archivedSessionIds;
				return typeof raw === "function" ? raw() ?? [] : Array.isArray(raw) ? raw : [];
			}
		},
		persistence: jsonFilePersistence(join(config.dataDir, "session-index.json")),
		logger: { warn: (message) => log.warn(message) }
	});
	sessionHeaderIndex.hydrate();
	ctx.effect(() => {
		const stop = sessionHeaderIndex.start();
		return () => {
			stop();
			return sessionHeaderIndex.dispose();
		};
	}, "dsh-router: 会话头候选索引（收编判定源）");
	bindSessionLifecycle(ctx, sessionHeaderIndex);
	const hosts = {
		sessionController: ctx.sessionController,
		agents: ctx.agents,
		workspaceRegistry,
		onSessionStatus: (callback) => {
			ctx.on("api-session/status", (sessionId, running) => callback(String(sessionId), Boolean(running)));
		}
	};
	const adjudicatorRef = {};
	let forkSeedFn;
	const loadForkSeed = async () => {
		if (forkSeedFn !== void 0) return forkSeedFn;
		try {
			forkSeedFn = (await import("@deepseek-ai/dsh-session/fork")).buildForkSeed;
		} catch (error) {
			log.warn(`@deepseek-ai/dsh-session/fork 不可用，minimal-face 分叉降级为普通创建: ${error instanceof Error ? error.message : String(error)}`);
		}
		return forkSeedFn;
	};
	loadForkSeed();
	const bridge = new SessionBridge({
		ledger,
		docsFor,
		workspaces: workspaceRegistry,
		onDelivered: (taskId) => {
			adjudicatorRef.current?.onDispatched(taskId);
		},
		presets: {
			supervisor: config.supervisorPreset,
			worker: config.workerPreset
		},
		forTemplate: resolvePresetForTemplate,
		types: { get: (templateId) => typeStore.get(templateId) },
		interruptFace: ctx.agents,
		workerInstructions: () => workerInstructionsText(),
		logger: { warn: (message) => log.warn(message) },
		signal: void 0,
		mode: spawnMode,
		identityCards: {
			has: (sessionId) => ui.hasIdentityCard(sessionId),
			mark: (sessionId) => ui.markIdentityCardSent(sessionId)
		},
		host: {
			create: async (opts, signal) => (await ctx.sessionController.create(opts, signal)).sessionId,
			prompt: (request, signal) => ctx.sessionController.prompt(request, signal),
			onStatus: (callback) => hosts.onSessionStatus(callback),
			rename: async (sessionId, title) => {
				await ctx.sessionController.rename({
					sessionId,
					title
				});
			},
			selectModel: typeof ctx.sessionController.selectModel === "function" ? (request, signal) => ctx.sessionController.selectModel(request, signal) : void 0,
			fork: typeof ctx.sessionController.fork === "function" ? (request, signal) => ctx.sessionController.fork(request, signal) : void 0,
			observeSession: async (sessionId) => {
				const observation = await ctx.sessionQuery.observeSession(sessionId);
				return {
					events: observation.events ?? [],
					dispose: () => releaseObservation(observation)
				};
			},
			buildForkSeed: async (events, boundary) => {
				const fn = await loadForkSeed();
				if (fn === void 0) return void 0;
				return fn(events, boundary);
			},
			newSessionId: () => `session-${randomUUID()}`,
			agentsCreate: typeof ctx.agents.create === "function" ? (options) => ctx.agents.create(options) : void 0,
			resolvePreset: typeof ctx.agentPresets.resolve === "function" ? (presetId) => ctx.agentPresets.resolve(presetId) : void 0,
			mountPreset: typeof ctx.agentPresets.mount === "function" ? (agentCtx, presetId) => ctx.agentPresets.mount(agentCtx, presetId) : void 0,
			attachWorkspace: async (workspaceId, sessionId) => {
				const workspace = ctx.workspaceRegistry.get?.(workspaceId);
				const attach = workspace?.attachSession;
				if (typeof attach !== "function") throw new Error("workspace 缺 attachSession 面");
				await attach.call(workspace, sessionId);
			}
		}
	});
	/**
	* Router 身份卡投递（v1.3 A2 规格 §2.2）：两个入口共用——①我们创建的 Router
	* 会话（POST /router/sessions 成功后）②picker 自建、被收编的 Router 会话
	* （GET /router/state 收编扫描后）。桥内按已发标记幂等，requestId=
	* identity-<sessionId> 宿主侧再去重。
	*
	* 两条路径的失败语义不同（review I2）：创建路径失败只告警（不打断主流程）；
	* **收编路径失败必须向上抛**——只有真成功才记账，否则失败被吞掉后收编器会
	* 把候选记成"已投递"，永久不再补发。
	*/
	const identityCardDeliverer = makeIdentityCardDeliverer((sessionId) => bridge.deliverRouterIdentityCard(sessionId), { warn: (message) => log.warn(message) });
	const deliverRouterCard = identityCardDeliverer.lenient;
	const deliverRouterCardStrict = identityCardDeliverer.strict;
	const engine = new DynamicPresetEngine({
		presets: ctx.agentPresets,
		effect: (factory, label) => ctx.effect(factory, label),
		skillDirs: () => void 0,
		logger: {
			info: (message) => log.info(message),
			warn: (message) => log.warn(message)
		}
	});
	ctx.effect(() => {
		const timer = setInterval(() => {
			engine.ensureRouterPresent(spawnMode());
		}, 6e4);
		return () => clearInterval(timer);
	}, "dsh-router: 预设注册表巡检");
	const syncTypePresets = async (record) => {
		if (!record.enabled || record.origin === "builtin") return;
		const outcome = await engine.syncTypes([record], spawnMode());
		for (const failed of outcome.failed) log.warn(`类型 ${failed} 的动态预设注册失败（派发会被拒；保存的类型数据不受影响）`);
	};
	const relay = new AnswerRelay({
		ledger,
		newId: () => randomUUID(),
		now: () => Date.now(),
		questionBudget: config.questionBudget,
		routerQuestions: {
			isRouterSession: (sessionId) => ui.routerSessions().some((entry) => entry.sessionId === sessionId),
			tryConsumeQuestionBatch: (sessionId) => budgets.tryConsumeQuestionBatch(sessionId)
		},
		logger: { warn: (message) => log.warn(message) }
	});
	const scheduler = new Scheduler(ledger, {
		maxDepth: config.maxDepth,
		concurrency: { default: config.perTypeConcurrency }
	});
	const memoryStore = new MemoryDocStore(join(config.dataDir, "memory"), fs);
	const closureIntents = new ClosureIntentStore({
		fs,
		path: join(config.dataDir, "closure-intents.json"),
		logger: { warn: (m) => log.warn(m) }
	});
	const notifications = new NotificationStore({
		fs,
		path: join(config.dataDir, "notifications.json"),
		newId: () => randomUUID(),
		logger: { warn: (m) => log.warn(m) }
	});
	const memoryQuery = { observeSession: (sessionId) => ctx.sessionQuery.observeSession(sessionId) };
	const resolveSummaryTarget = async () => {
		if (config.summarizationProvider !== "" && config.summarizationModel !== "") return {
			provider: config.summarizationProvider,
			model: config.summarizationModel
		};
		const records = await ledger.listAll();
		for (const record of records) {
			if (record.sessionId === void 0) continue;
			const routed = ctx.agents.get(record.sessionId)?.session?.requestHeader?.()?.config;
			if (routed !== void 0 && typeof routed.provider === "string" && routed.provider !== "" && typeof routed.model === "string" && routed.model !== "") return {
				provider: routed.provider,
				model: routed.model
			};
		}
	};
	const summaryLlm = createSummaryLlm(ctx.llm, resolveSummaryTarget);
	const summarizer = new BackgroundSummarizer({
		maxSeq: (sessionId) => maxSurfaceSeq(memoryQuery, sessionId),
		run: (sessionId) => summarizeSessionViaQuery(memoryQuery, memoryStore, sessionId, summaryLlm),
		onError: (sessionId, error) => {
			log.warn(`会话 ${sessionId} 记忆增量摘要失败（下次 idle 或新事件后重试）: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	const recordTaskMemory = createCompletedTaskRecorder({
		store: memoryStore,
		query: memoryQuery,
		llm: summaryLlm,
		onError: (_stage, error) => {
			log.warn(`任务完成的记忆写入失败（不阻塞完成协议）: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	/** 该会话是否绑定了任务（= worker/主管会话；Router 会话不做增量摘要）。 */
	const isTaskSession = async (sessionId) => {
		return (await ledger.listAll()).some((record) => record.sessionId === sessionId);
	};
	/** routerCore.memory（brief 形状：search 直传 retrieval）。 */
	const memoryFace = {
		search: (query, scope) => search(memoryStore, query, scope),
		onTaskCompleted: (input) => recordTaskMemory(input)
	};
	let pairing = null;
	const queueWarned = /* @__PURE__ */ new Set();
	const loadPairing = async () => {
		if (pairing !== null) return pairing;
		try {
			const mod = await import("@deepseek-ai/dsh-compaction");
			pairing = {
				before: mod.toolPairingBalancedBefore,
				after: mod.toolPairingBalancedAfter
			};
		} catch (error) {
			log.warn(`dsh-compaction 配对函数不可用，压缩区域预检放行: ${error instanceof Error ? error.message : String(error)}`);
			pairing = {
				before: () => true,
				after: () => true
			};
		}
		return pairing;
	};
	const driver = new CompactionDriver({
		getAgent: (sessionId) => ctx.agents.get(sessionId),
		queueEmpty: async (sessionId) => {
			try {
				const queue = (await ctx.sessionController.state({ sessionId }))?.queue;
				return queue === void 0 || queue === null || queue.length === 0;
			} catch (error) {
				if (!queueWarned.has(sessionId)) {
					queueWarned.add(sessionId);
					log.warn(`会话 ${sessionId} 排队状态查询失败，派发后压缩将暂缓: ${error instanceof Error ? error.message : String(error)}`);
				}
				throw error;
			}
		},
		lastUserMessageSeq: async (sessionId) => {
			const sessionQuery = ctx.sessionQuery;
			if (sessionQuery === void 0) return null;
			try {
				const events = (await sessionQuery.readSurface?.(sessionId))?.events ?? [];
				for (let i = events.length - 1; i >= 0; i -= 1) if (events[i]?.type === "user/message") return events[i].seq;
				return null;
			} catch {
				return null;
			}
		},
		balancedBefore: async (session, seq) => Boolean((await loadPairing()).before(session, seq)),
		balancedAfter: async (session, seq) => Boolean((await loadPairing()).after(session, seq)),
		compactRegion: async (start, end, agent, signal) => {
			const engine$1 = agent?.ctx?.compaction;
			if (engine$1?.compactRegion === void 0) throw new Error("compaction engine 在目标会话作用域内不可用（预设未挂 compaction 组？）");
			return engine$1.compactRegion(start, end, agent, signal);
		},
		now: () => Date.now()
	});
	const assembled = createRouterCore({
		notifications,
		ledger,
		docsFor,
		bridge,
		relay,
		driver,
		scheduler,
		ui,
		hosts,
		config,
		types: {
			enabled: () => typeStore.enabledTemplates(),
			summaries: () => typeStore.summaries(),
			createRouterType: async (input) => {
				const record = await typeStore.create({
					...input,
					origin: "router",
					enabled: true
				});
				return {
					record,
					presetRegistered: await engine.ensureRegistered(record, spawnMode())
				};
			}
		},
		routerDefaults: { get: () => defaultsStore.get() },
		newId: () => randomUUID(),
		isRunning: (sessionId) => bridge.isRunning(sessionId),
		maxActiveCards: config.maxActiveCards,
		tasksDir: config.tasksDir,
		memory: memoryFace,
		breaker,
		budgets,
		logger: { warn: (message) => log.warn(message) }
	});
	ctx.provide("routerCore", {
		...assembled.core,
		snapshotText: assembled.snapshotText,
		sessionPromptText,
		memory: { search: memoryFace.search },
		callerRoleOf: (sessionId) => assembled.core.callerRoleOf(sessionId)
	});
	const adjudicator = new OutcomeAdjudicator({
		ledger,
		observeSession: async (sessionId, options) => {
			const observation = await ctx.sessionQuery.observeSession(sessionId);
			try {
				return { events: observation.events ?? [] };
			} finally {
				observation.dispose?.();
			}
		},
		prompt: (request) => ctx.sessionController.prompt(request, AbortSignal.timeout(12e4)),
		sessionState: async (sessionId) => {
			const state = ctx.sessionController.state;
			return state === void 0 ? void 0 : await state(sessionId);
		},
		agentsGet: (sessionId) => {
			const agent = ctx.agents.get(sessionId);
			return agent === void 0 || agent.status === void 0 ? void 0 : { status: agent.status };
		},
		llm: summaryLlm,
		core: {
			completeTask: (caller, taskId, input) => assembled.core.completeTask(caller, taskId, input),
			reportBlocker: (caller, taskId, reason) => assembled.core.reportBlocker(caller, taskId, reason)
		},
		intents: closureIntents,
		recordIncident: (entry) => {
			memoryStore.appendSummary("project", `任务 ${entry.taskId}`, {
				sourceRefs: [`task:${entry.taskId}`],
				kind: "verified-fact",
				text: entry.text
			}).catch((error) => {
				log.warn(`事故记忆写入失败（${entry.taskId}）: ${error instanceof Error ? error.message : String(error)}`);
			});
		},
		now: () => Date.now(),
		schedule: (delayMs, fn) => {
			const timer = setTimeout(() => {
				fn();
			}, delayMs);
			return () => clearTimeout(timer);
		},
		...config.firstResponseTimeoutMs !== void 0 ? { firstResponseTimeoutMs: config.firstResponseTimeoutMs } : {},
		...config.adjudicationWallClockMs !== void 0 ? { adjudicationWallClockMs: config.adjudicationWallClockMs } : {},
		logger: { warn: (m) => log.warn(m) }
	});
	adjudicatorRef.current = adjudicator;
	bridge.watchStatus();
	bridge.onStatusChange((sessionId, running) => {
		if (running) budgets.onTurnStart(sessionId);
	});
	bridge.onStatusChange((sessionId, running) => {
		if (running) return;
		driver.onIdle(sessionId).then((outcome) => {
			if (outcome === "compacted") log.info(`会话 ${sessionId} 派发后上下文整理完成`);
		});
		(async () => {
			if (!await isTaskSession(sessionId)) return;
			summarizer.onIdle(sessionId);
		})();
	});
	bridge.onStatusChange((sessionId, running) => {
		if (running) adjudicator.onTurnStart(sessionId);
		else adjudicator.onTurnEnd(sessionId);
	});
	adjudicator.syncWatched();
	ctx.on("user-questions/request", (async (request, next) => {
		const outcome = await relay.claimQuestion(request, next);
		assembled.refreshSnapshot();
		return outcome;
	}), { prepend: true });
	const cacheObserver = new FirstRequestCacheObserver({
		ledger,
		logger: { warn: (message) => log.warn(message) }
	});
	ctx.on("session/event", ((session, event) => {
		cacheObserver.onSessionEvent(session, event);
	}));
	ctx.effect(() => {
		(async () => {
			defaultsText = (await defaultsStore.get()).routerSystemPrompt;
			const routerOutcome = await engine.syncRouter(spawnMode());
			const enabledTypes = (await typeStore.list()).filter((record) => record.enabled);
			const outcomes = await engine.syncTypes(enabledTypes, spawnMode());
			if (outcomes.failed.length > 0) log.warn(`动态预设注册失败被跳过的类型（派发会被拒）: ${outcomes.failed.join("、")}`);
			log.info(`动态预设同步完成：Router=${routerOutcome}，类型注册 ${outcomes.registered.length} 个（内置 ${BUILTIN_GENERAL_ID} 走静态预设）`);
			await sessionPrompts.load();
			await ui.load();
			await ledger.listAll();
			const recovered = await assembled.recoverOrphans();
			if (recovered.length > 0) log.warn(`重启恢复：${recovered.length} 个待答问题已失效，对应任务标为受阻`);
			const guardState = await breaker.state();
			if (guardState.frozen) {
				const frozenAt = guardState.frozenAt !== void 0 ? new Date(guardState.frozenAt).toISOString() : "未知时间";
				log.warn(`重启恢复：派发已冻结（${guardState.reason ?? "原因未记录"}，冻结于 ${frozenAt}）——请停止重试并向用户报告，直至用户解除`);
			}
			await assembled.refreshSnapshot();
			log.info("routerCore 就绪");
		})();
	}, "dsh-router: 启动恢复与动态预设同步");
	ctx.inject?.(["webServer", "connection"], (child) => {
		registerRouterRoutes(child, {
			getHealth: async () => ({
				...sessionHeaderIndex.diagnostics(),
				adoption: routerAdoptionDiagnostics(adoptionCache)
			}),
			getState: async (workspaceId) => {
				try {
					await scanAndAdoptRouterSessions({
						index: sessionHeaderIndex,
						known: (sessionId) => ui.routerSessions().some((entry) => entry.sessionId === sessionId),
						register: async (sessionId, wsId) => {
							await ui.addRouterSession(sessionId, wsId, "Router");
						},
						deliver: async (sessionId) => {
							await deliverRouterCardStrict(sessionId);
						},
						logger: { warn: (message) => log.warn(message) }
					}, config.routerPreset, adoptionCache);
				} catch (error) {
					log.warn(`Router 会话收编扫描失败（下轮重试）: ${error instanceof Error ? error.message : String(error)}`);
				}
				const state = await assembled.workbench.state(workspaceId);
				const rosterIds = await ctx.agentPresets.list().then((rows) => rows.map((row) => row.id)).catch(() => []);
				return {
					...state,
					presets: {
						routerRegistered: rosterIds.includes("dsh-router"),
						typePresetIds: rosterIds.filter((id) => id.startsWith("dsh-router"))
					}
				};
			},
			createRouterSession: async (workspaceId, name$1) => {
				await engine.ensureRouterPresent(spawnMode());
				const created = await assembled.workbench.createRouterSession(workspaceId, name$1);
				await deliverRouterCard(created.sessionId);
				return created;
			},
			answerQuestion: async (questionId, answers) => {
				await assembled.workbench.answerQuestion(questionId, answers);
				assembled.refreshSnapshot();
			},
			closeTab: (workspaceId, sessionId) => assembled.workbench.closeTab(workspaceId, sessionId),
			listWorkerTypes: async () => ({ types: await typeStore.list() }),
			createWorkerType: async (input) => {
				const type = await typeStore.create(input);
				await syncTypePresets(type);
				return { type };
			},
			updateWorkerType: async ({ templateId, patch }) => {
				const type = await typeStore.update(templateId, patch);
				await syncTypePresets(type);
				return { type };
			},
			setWorkerTypeEnabled: async ({ templateId, enabled }) => {
				const type = await typeStore.setEnabled(templateId, enabled);
				await syncTypePresets(type);
				return { type };
			},
			removeWorkerType: async (templateId) => {
				await typeStore.remove(templateId);
				await engine.removeType(templateId);
			},
			getDefaults: () => defaultsStore.get(),
			saveDefaults: async (value) => {
				const saved = await defaultsStore.set(value);
				defaultsText = saved.routerSystemPrompt;
				return saved;
			},
			getSpawnMode: async () => ({ mode: spawnMode() }),
			saveSpawnMode: async (mode) => {
				currentSpawnMode = mode;
				return { mode: spawnMode() };
			},
			getSessionPrompt: async (sessionId) => {
				const override = sessionPrompts.get(sessionId);
				return override !== void 0 ? {
					prompt: override,
					isDefault: false
				} : {
					prompt: defaultsText,
					isDefault: true
				};
			},
			saveSessionPrompt: async (sessionId, prompt) => {
				if (prompt === "") await sessionPrompts.clear(sessionId);
				else await sessionPrompts.set(sessionId, prompt);
			},
			ackNotification: (cardId) => notifications.ack(cardId),
			controlTask: async (taskId, action, note) => {
				if (action === "redispatch") {
					const breakerState = await breaker.state();
					if (breakerState.frozen) throw new LedgerError("dispatch-frozen", `派发已冻结（${breakerState.reason ?? "原因未记录"}）：重派被拒——请先解除冻结（POST /router/breaker/unfreeze 或工作台「解除冻结」），再重派任务 ${taskId}`);
					await assembled.core.supplementTask("user", taskId, ["用户重派：请按任务书当前版本推进（用户经控制路由发起）"]);
					return { status: assembled.core.getTask(taskId)?.status ?? "failed" };
				}
				return assembled.core.controlTask("user", taskId, action, note);
			},
			unfreezeBreaker: async () => {
				const beforeState = await breaker.state();
				const before = { frozen: beforeState.frozen };
				if (beforeState.frozen) {
					if (beforeState.reason !== void 0) before.reason = beforeState.reason;
					if (beforeState.frozenAt !== void 0) before.frozenAt = beforeState.frozenAt;
				}
				await breaker.unfreeze();
				const afterState = await breaker.state();
				await assembled.core.dispatchReady();
				return {
					before,
					after: { frozen: afterState.frozen }
				};
			},
			scopedPause: (routerSessionId) => assembled.core.scopedPause(routerSessionId)
		});
	});
	function workerInstructionsText() {
		return workerInstructions;
	}
}

//#endregion
export { Config, apply, bindSessionLifecycle, inject, makeIdentityCardDeliverer, name, resolveRootConfig, spawnModeOr };
//# sourceMappingURL=entry.js.map