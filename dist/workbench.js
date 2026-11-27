import Schema from "@deepseek-ai/schemastery";

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
//#region src/collaboration/routes.ts
/** 三条路由前缀（与客户端 api 一侧逐字对齐）。 */
const COLLABORATION_RECORDS_PATH = "/router/collaboration/records";
const COLLABORATION_RECORD_PATH = "/router/collaboration/record";
const COLLABORATION_ROLES_PATH = "/router/collaboration/roles";
const COLLABORATION_MODELS_PATH = "/router/collaboration/models";
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
		if (typeof body.id === "string" && body.id.trim() !== "") input.id = body.id.trim();
		if (Object.prototype.hasOwnProperty.call(body, "models")) input.models = body.models;
		const saved = await deps.roles.save(input);
		return {
			status: 200,
			body: JSON.stringify(saved)
		};
	});
	handle(COLLABORATION_MODELS_PATH, ["GET"], async () => {
		const sc = deps.sessionController?.();
		if (sc === void 0 || typeof sc.modelCatalog !== "function") return {
			status: 200,
			body: JSON.stringify({
				unavailable: true,
				providers: []
			})
		};
		try {
			const catalog = await sc.modelCatalog();
			if (catalog === null || typeof catalog !== "object" || !Array.isArray(catalog.groups)) return {
				status: 200,
				body: JSON.stringify({
					unavailable: true,
					providers: []
				})
			};
			const providers = catalog.groups.flatMap((group) => {
				if (group === null || typeof group !== "object" || typeof group.id !== "string") return [];
				const name$1 = typeof group.name === "string" ? group.name : group.id;
				const models = Array.isArray(group.models) ? group.models.flatMap((item) => item !== null && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string" ? [{
					id: item.id,
					name: item.name
				}] : []) : [];
				return [{
					id: group.id,
					name: name$1,
					models
				}];
			});
			return {
				status: 200,
				body: JSON.stringify({
					unavailable: false,
					providers
				})
			};
		} catch {
			return {
				status: 200,
				body: JSON.stringify({
					unavailable: true,
					providers: []
				})
			};
		}
	});
}

//#endregion
//#region src/workbench.ts
/** 本入口的插件名（诊断显示用）。 */
const name = "router-workbench";
/** 必需依赖：webServer/connection 挂路由，routerCollaboration 取共享存储单实例。 */
const inject = [
	"webServer",
	"connection",
	"routerCollaboration"
];
/** 行配置：无（与 tools 行同款空对象，让形状显式、可测）。 */
const Config = Schema.object({});
/**
* 注册四条工作台路由（records / record / roles / models），与工具行共享同一
* RecordStore/RoleStore 单实例。sessionController 可选注入（models 路由用）；取不到时
* models 路由返回 unavailable:true。返回联合注销器交给宿主 effect 生命周期。
*/
function apply(ctx) {
	let scFace;
	let scWarned = false;
	const warnScUnavailable = () => {
		if (scWarned) return;
		scWarned = true;
		console.warn("[dsh-router] workbench: sessionController.modelCatalog 不可用，models 路由将返回 unavailable:true");
	};
	const fibers = [];
	const track = (fiber) => {
		if (typeof fiber === "object" && fiber !== null) fibers.push(fiber);
	};
	const injectFn = ctx.inject;
	if (typeof injectFn !== "function") warnScUnavailable();
	else track(injectFn(["sessionController"], (child) => {
		const sc = child.sessionController;
		if (sc !== void 0 && typeof sc.modelCatalog === "function") scFace = sc;
		else warnScUnavailable();
	}));
	try {
		registerCollaborationRoutes(ctx, {
			records: ctx.routerCollaboration.records,
			roles: ctx.routerCollaboration.roles,
			sessionController: () => scFace
		});
		console.log("[dsh-router] workbench routes registered: /router/collaboration/records, /router/collaboration/record, /router/collaboration/roles, /router/collaboration/models");
	} catch (error) {
		console.warn("[dsh-router] workbench routes registration failed:", error instanceof Error ? error.message : String(error));
	}
	return () => {
		for (const fiber of fibers) try {
			const result = fiber.dispose?.();
			if (result !== void 0 && typeof result.then === "function") result.catch(() => {});
		} catch {}
	};
}

//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=workbench.js.map