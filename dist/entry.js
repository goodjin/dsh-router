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
function isEnoent$2(error) {
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
				if (isEnoent$2(error)) continue;
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
			if (isEnoent$2(error)) throw new CollaborationError("NOT_FOUND", `${what}不存在`);
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
const NAMESPACE$1 = "collaboration";
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
function isEnoent$1(error) {
	return typeof error === "object" && error !== null && error.code === "ENOENT";
}
function isUuid(value) {
	return UUID_RE.test(value);
}
/** 非空字符串判定（可选字段与必需字段共用同一规则，不 as 虚假类型掩盖检查）。 */
function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}
/** 非空字符串校验（title/name 等非空必需字段）。 */
function requireNonEmptyString(value, what) {
	if (!isNonEmptyString(value)) throw new CollaborationError("INVALID_INPUT", `${what} 必须是非空字符串`);
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
		if (!isNonEmptyString(l.sessionId) || !isNonEmptyString(l.label)) return false;
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
		if (!isNonEmptyString(r.location) || !isNonEmptyString(r.label)) return false;
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
	return typeof r.id === "string" && typeof r.taskId === "string" && typeof r.rootSessionId === "string" && isNonEmptyString(r.title) && typeof r.body === "string" && typeof r.createdAt === "number" && typeof r.updatedAt === "number" && RECORD_KINDS.has(r.kind) && (r.workLabel === void 0 || WORK_LABELS.has(r.workLabel)) && areSessionLinksValid(r.sessions) && areArtifactRefsValid(r.artifacts) && (r.parentRecordId === void 0 || typeof r.parentRecordId === "string" && isUuid(r.parentRecordId));
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
	const base = join(dataDir, NAMESPACE$1);
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
			if (isEnoent$1(error)) throw new CollaborationError("NOT_FOUND", `记录不存在: ${path}`);
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
				if (parentRecordId !== void 0) await requireParent(rootSessionId, taskId, parentRecordId);
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
				if (isEnoent$1(error)) return [];
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
					if (isEnoent$1(error)) continue;
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
//#region src/collaboration/roles.ts
const ROLE_EXT = ".md";
const LEGACY_EXT = ".json";
const NAMESPACE = "collaboration";
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
function isEnoent(error) {
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
	const base = join(dataDir, NAMESPACE);
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
			if (isEnoent(error)) throw new CollaborationError("NOT_FOUND", `角色模板不存在: ${path}`);
			throw new CollaborationError("IO_ERROR", `角色模板读取失败: ${path}`, { cause: error });
		}
		return {
			name: name$1,
			description: text
		};
	};
	return {
		async list() {
			let names;
			try {
				await guard.assertDirectory(rolesDir);
				names = await fs.readdir(rolesDir);
			} catch (error) {
				if (isEnoent(error)) return [];
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
			return enqueue(async () => {
				const path = rolePath(name$1);
				await guard.assertDirChain(path);
				await atomicWrite(fs, path, input.description);
				return {
					name: name$1,
					description: input.description
				};
			});
		},
		async migrateLegacyJson() {
			let names;
			try {
				await guard.assertDirectory(rolesDir);
				names = await fs.readdir(rolesDir);
			} catch (error) {
				if (isEnoent(error)) return;
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
					if (!isEnoent(error)) throw error;
				}
				await atomicWrite(fs, rolePath(name$1), legacy.description);
			}
		}
	};
}
/** 首次启用种入的预置角色。 */
const PRESET_ROLE_TEMPLATES = [
	{
		name: "主管",
		description: "把任务拆成可独立执行的分工，派给合适的成员，跟进进度并汇总结果向上报告；不亲自执行具体工作。"
	},
	{
		name: "执行者",
		description: "接受分工后独立完成具体工作（编码、修改、验证），自检通过后把结果与产物位置报告上级。"
	},
	{
		name: "调研员",
		description: "查资料、读源码与文档，产出结论与证据位置供决策参考；只调研不改动。"
	},
	{
		name: "评审员",
		description: "对照任务说明的验收条件检查交付，给出通过或问题清单；评审不代做修改。"
	}
];
/**
* 幂等种入预置角色：按名判断——已存在（含用户改过的）跳过，不覆盖用户编辑；
* 缺失则新建同名 md。并发双开最坏是同路径同内容覆盖，不产生重复角色。
*/
async function seedPresetRoles(store) {
	const existing = new Set((await store.list()).map((role) => role.name));
	for (const preset of PRESET_ROLE_TEMPLATES) {
		if (existing.has(preset.name)) continue;
		await store.save({
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
//#region src/collaboration/routes.ts
/** 三条路由前缀（与客户端 api 一侧逐字对齐）。 */
const COLLABORATION_RECORDS_PATH = "/router/collaboration/records";
const COLLABORATION_RECORD_PATH = "/router/collaboration/record";
const COLLABORATION_ROLES_PATH = "/router/collaboration/roles";
/** POST 体上限：1MiB（1024×1024）简单 UI 传输限（非源存储约束）；按累计字节计，非 string 长度。 */
const BODY_LIMIT = 1024 * 1024;
/**
* 请求体超过 1MiB 上限。HTTP 层传输契约错误，**不进** CollaborationError 枚举
* （该枚举只容记录/模板四码），由 errorStatus 映射 413、errorCodeOf 给 BODY_TOO_LARGE。
*/
var BodyTooLargeError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "BodyTooLargeError";
	}
};
/** CollaborationError.code → HTTP 状态。 */
function errorStatus(error) {
	if (error instanceof BodyTooLargeError) return 413;
	if (error instanceof SyntaxError) return 400;
	if (error instanceof CollaborationError) switch (error.code) {
		case "INVALID_INPUT": return 400;
		case "NOT_FOUND": return 404;
		case "CORRUPT_RECORD":
		case "IO_ERROR": return 500;
		default: return 500;
	}
	return 500;
}
/** 错误体里的 code：让客户端按 code 分流（store 错误用其 code，其余给传输码）。 */
function errorCodeOf(error, status) {
	if (error instanceof CollaborationError) return error.code;
	if (error instanceof SyntaxError) return "INVALID_INPUT";
	if (status === 405) return "METHOD_NOT_ALLOWED";
	if (status === 413) return "BODY_TOO_LARGE";
	return "INTERNAL_ERROR";
}
/** JSON 应答：no-store + 显式长度。 */
function respondJson(response, status, body) {
	response.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	response.end(body);
}
/**
* 读请求体：按**累计字节**（Buffer.length，非解码后 string 长度）限 1MiB。
* 跨块的多字节字符在 `end` 时一次性 `Buffer.concat` 解码，避免逐块 toString 把中文拆字成替换符。
* 越限即拒（停止累计、不销毁 socket，让 413 正常回出）；拒绝后再来的 data/end/error 一律忽略。
*/
function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		request.on("data", (chunk) => {
			if (settled) return;
			size += chunk.length;
			if (size > BODY_LIMIT) {
				settled = true;
				reject(new BodyTooLargeError(`请求体过大（超过 ${BODY_LIMIT} 字节上限）`));
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			if (settled) return;
			settled = true;
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		request.on("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
	});
}
/**
* 挂 exact 路由。webServer/connection 缺席时不挂（不挡装载）；
* 每条路由先过 connection.admit 同一登录准入，再校验方法，再进逻辑。
*/
function registerCollaborationRoutes(ctx, deps) {
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
					response.writeHead(405, { allow });
					response.end(JSON.stringify({ error: {
						code: "METHOD_NOT_ALLOWED",
						message: `method not allowed（允许 ${allow}）`
					} }));
					return;
				}
				try {
					const { status, body } = await logic(request);
					respondJson(response, status, body);
				} catch (error) {
					const status = errorStatus(error);
					const code = errorCodeOf(error, status);
					const message = status >= 500 ? error instanceof CollaborationError ? error.message : "internal error" : error instanceof Error ? error.message : String(error);
					respondJson(response, status, JSON.stringify({ error: {
						code,
						message
					} }));
				}
			}
		}), `dsh-router: collaboration ${allow} ${path}`);
	};
	handle(COLLABORATION_RECORDS_PATH, ["GET"], async (request) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const rootSessionId = url.searchParams.get("rootSessionId") ?? "";
		if (rootSessionId === "") throw new CollaborationError("INVALID_INPUT", "rootSessionId 查询参数必填");
		const taskId = url.searchParams.get("taskId") ?? void 0;
		const kindParam = url.searchParams.get("kind") ?? void 0;
		const query = {};
		if (taskId !== void 0) query.taskId = taskId;
		if (kindParam !== void 0) query.kind = kindParam;
		const records = await deps.records.list(rootSessionId, query);
		return {
			status: 200,
			body: JSON.stringify(records)
		};
	});
	handle(COLLABORATION_RECORD_PATH, ["GET"], async (request) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const rootSessionId = url.searchParams.get("rootSessionId") ?? "";
		const taskId = url.searchParams.get("taskId") ?? "";
		const recordId = url.searchParams.get("recordId") ?? "";
		if (rootSessionId === "") throw new CollaborationError("INVALID_INPUT", "rootSessionId 查询参数必填");
		if (taskId === "") throw new CollaborationError("INVALID_INPUT", "taskId 查询参数必填");
		if (recordId === "") throw new CollaborationError("INVALID_INPUT", "recordId 查询参数必填");
		const saved = await deps.records.read(rootSessionId, taskId, recordId);
		return {
			status: 200,
			body: JSON.stringify(saved)
		};
	});
	handle(COLLABORATION_ROLES_PATH, ["GET", "POST"], async (request) => {
		if (request.method === "GET") {
			const roles = await deps.roles.list();
			return {
				status: 200,
				body: JSON.stringify(roles)
			};
		}
		const raw = await readBody(request);
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new CollaborationError("INVALID_INPUT", `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new CollaborationError("INVALID_INPUT", "请求体须为 JSON 对象");
		const body = parsed;
		const input = {
			name: typeof body.name === "string" ? body.name : "",
			description: typeof body.description === "string" ? body.description : ""
		};
		const saved = await deps.roles.save(input);
		return {
			status: 200,
			body: JSON.stringify(saved)
		};
	});
}

//#endregion
//#region src/entry.ts
/** Loader 行与诊断里看到的插件名（裸包名，与 cordis.patch.yml 的行一致）。 */
const name = "@goodjin2/dsh-router";
/**
* 根服务不 require 任何旧宿主服务：它只 provide 一个纯内存运行时。
* webServer/connection 经官方 ctx.inject 机会式注入（见 apply），不进全局必需数组——
* 否则缺席时整行装载失败、CLI 记录/工具服务也被拖死（brief：不能 required 使 CLI 不可用）。
*/
const inject = [];
/** 根配置：只有 dataDir，全部可缺省（缺省 DSH_HOME/router，运行时解析一次）。 */
const Config = Schema.object({ dataDir: Schema.string().default("") });
/**
* 装载入口：组装根服务并 provide，再机会式挂三条薄路由。标准 Cordis 生命周期——
* 返回注销器（路由注册与存储单实例随 fiber 销毁自然回收；保留 disposer 形状）。
*/
function apply(ctx, rawConfig) {
	const config = rawConfig ?? {};
	const runtime = createCollaborationRuntime({ dataDir: typeof config.dataDir === "string" ? config.dataDir : void 0 });
	const face = {
		records: runtime.records,
		roles: runtime.roles,
		dataDir: runtime.dataDir
	};
	(!!ctx.root?.provide ? ctx.root.provide.bind(ctx.root) : ctx.provide.bind(ctx))("routerCollaboration", face);
	runtime.roles.migrateLegacyJson().then(() => seedPresetRoles(runtime.roles)).catch((error) => {
		console.warn("[dsh-router] migrate/seed roles failed:", error instanceof Error ? error.message : String(error));
	});
	ctx.inject?.(["webServer", "connection"], (child) => {
		registerCollaborationRoutes(child, {
			records: runtime.records,
			roles: runtime.roles
		});
	});
	return () => {};
}

//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=entry.js.map