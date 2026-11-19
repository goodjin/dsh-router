import Schema from "@deepseek-ai/schemastery";
import { join } from "node:path";

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
//#region src/collaboration/dispatch.ts
/** 宿主 dsh-subagent.startActivation 内部第一行就 spec.signal.throwIfAborted()（非可选，
*  0.2.1 与 0.2.2 皆然），缺 signal 直接 TypeError。优先用调用方 turn 的 exec.signal；
*  缺席时兜底插件级 controller（同 agent-kernel D2），保证任何宿主下都传真实 AbortSignal。 */
const dispatchLifetime = new AbortController();

//#endregion
//#region src/collaboration/tools.ts
const RECORD_KINDS = [
	"task",
	"assignment",
	"report",
	"summary"
];
const WORK_LABELS = [
	"待处理",
	"进行中",
	"受阻",
	"已报告"
];
/** 关联会话条目（sessions 元素）。 */
const SESSION_LINK_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		sessionId: {
			type: "string",
			description: "关联会话 ID"
		},
		label: {
			type: "string",
			description: "展示标签"
		}
	},
	required: ["sessionId", "label"]
};
/** 成果引用条目（artifacts 元素）。 */
const ARTIFACT_REF_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		location: {
			type: "string",
			description: "成果位置"
		},
		label: {
			type: "string",
			description: "展示标签"
		}
	},
	required: ["location", "label"]
};
/** 工作记录本体的 schema（存储返回值里 record 的形状）。 */
const RECORD_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: {
			type: "string",
			description: "记录编号"
		},
		taskId: {
			type: "string",
			description: "归属任务 ID"
		},
		rootSessionId: {
			type: "string",
			description: "根会话 ID"
		},
		kind: {
			type: "string",
			enum: [...RECORD_KINDS],
			description: "记录种类"
		},
		title: {
			type: "string",
			description: "标题"
		},
		body: {
			type: "string",
			description: "正文"
		},
		workLabel: {
			type: "string",
			enum: [...WORK_LABELS],
			description: "工作标签"
		},
		parentRecordId: {
			type: "string",
			description: "父记录编号"
		},
		sessions: {
			type: "array",
			description: "关联会话",
			items: SESSION_LINK_SCHEMA
		},
		artifacts: {
			type: "array",
			description: "成果引用",
			items: ARTIFACT_REF_SCHEMA
		},
		createdAt: {
			type: "number",
			description: "创建时间戳"
		},
		updatedAt: {
			type: "number",
			description: "更新时间戳"
		}
	},
	required: [
		"id",
		"taskId",
		"rootSessionId",
		"kind",
		"title",
		"body",
		"createdAt",
		"updatedAt"
	]
};
/** 固定八个工具名（注册与上下文共用的基准顺序）。 */
const COLLABORATION_TOOL_NAMES = [
	"router_dispatch",
	"router_record_create",
	"router_record_read",
	"router_record_list",
	"router_record_update",
	"router_role_list",
	"router_role_read",
	"router_role_save"
];

//#endregion
//#region src/collaboration/context.ts
/** 协作目录名（与 RecordStore/RoleStore 的命名空间一致；只拼一次）。 */
const COLLABORATION_DIR = "collaboration";
/** 非空字符串校验（坏入参直接拒绝，不产出误导文本）。 */
function requireNonEmptyString(value, what) {
	if (typeof value !== "string" || value.length === 0) throw new CollaborationError("INVALID_INPUT", `${what} 必须是非空字符串`);
	return value;
}
/**
* 构建协作上下文文本。纯函数：相同入参恒等输出，可安全在渲染期重复调用。
*/
function buildCollaborationContext(input) {
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new CollaborationError("INVALID_INPUT", "input 必须是对象");
	const sessionId = requireNonEmptyString(input.sessionId, "sessionId");
	const collaborationDir = join(requireNonEmptyString(input.dataDir, "dataDir"), COLLABORATION_DIR);
	const toolList = COLLABORATION_TOOL_NAMES.join(", ");
	return [
		"当前会话 ID：" + sessionId,
		"注意：这是当前会话的 ID，不是根会话（root）ID，不要把它当作 rootSessionId 使用。",
		"",
		"协作记录目录：" + collaborationDir,
		"所有工作记录与角色模板都存在该目录下的 JSON 文件里，文件是唯一事实源。",
		"",
		"根会话（rootSessionId）必须由父级会话随每次操作显式传入；",
		"如果你拿不到 rootSessionId，请向上级会话询问，不要自行推断或猜测。",
		"",
		"可用的协作工具（共 " + String(COLLABORATION_TOOL_NAMES.length) + " 个）：" + toolList,
		"记录种类：task（任务说明）、assignment（分工记录）、report（工作报告）、summary（汇总报告）。",
		"",
		...renderRoles(input.roles)
	].join("\n");
}
/** 角色清单段：注入名称与首行摘要（v2 两层结构）+ 用法指引；缺失/为空各自如实说明并指向工具。 */
function renderRoles(roles) {
	const header = "角色模板（专业类型）：派子会话时，把选中角色的职责说明连同任务要求一起写进给子会话的初始指令。";
	if (roles === void 0) return [header, "角色清单暂不可用（尚未加载完成）：用 router_role_list 查询最新。"];
	if (roles.length === 0) return [header, "暂无角色模板：用 router_role_save 新建，或在协作页角色区创建。"];
	return [
		header,
		...roles.map((role) => `- ${role.name}：${dutySummary(role.description) === "" ? "（无职责说明）" : dutySummary(role.description)}`),
		"最新清单与详情用 router_role_list / router_role_read 查询；router_role_save 可新增或修改。"
	];
}
/** 职责摘要：取第一个非空行（v2 两层结构的首行；清单只注入摘要，控制上下文体积，全文派发时才用）。 */
function dutySummary(description) {
	for (const line of description.split("\n")) {
		const trimmed = line.trim();
		if (trimmed !== "") return trimmed;
	}
	return "";
}

//#endregion
//#region src/context.ts
/** 本入口的插件名（诊断显示用）。 */
const name = "router-context";
const inject = ["systemPrompt", "routerCollaboration"];
const Config = Schema.object({
	order: Schema.number().default(100),
	rolesTtlMs: Schema.number().default(3e4)
});
/** 从当次组装上下文取真实当前会话 ID（agent.id）；取不到返回 undefined。 */
function currentSessionId(assembly) {
	if (typeof assembly !== "object" || assembly === null) return void 0;
	const agent = assembly.agent;
	if (typeof agent !== "object" || agent === void 0) return void 0;
	const id = agent.id;
	return typeof id === "string" && id !== "" ? id : void 0;
}
/** 缺 agent 面时的诊断文本：不臆造会话身份，仍给出工具与协作目录。 */
function diagnosticText(dataDir) {
	return buildCollaborationContext({
		sessionId: "unknown",
		dataDir
	}).replace("当前会话 ID：unknown", "当前会话 ID：不可用（宿主未在本次组装中提供 agent 面；不要臆造 rootSessionId，向上级会话询问）");
}
/** 注册协作上下文；返回注销器交给宿主 effect 生命周期。 */
function apply(ctx, config) {
	const order = typeof config.order === "number" && Number.isFinite(config.order) ? config.order : 100;
	const ttlMs = typeof config.rolesTtlMs === "number" && Number.isFinite(config.rolesTtlMs) && config.rolesTtlMs >= 0 ? config.rolesTtlMs : 3e4;
	const dataDir = ctx.routerCollaboration.dataDir;
	const cache = {
		value: void 0,
		at: -Infinity,
		loading: false
	};
	const refresh = async () => {
		if (cache.loading) return;
		cache.loading = true;
		try {
			const list = ctx.routerCollaboration.roles?.list;
			if (typeof list !== "function") {
				cache.at = Date.now();
				return;
			}
			cache.value = await list.call(ctx.routerCollaboration.roles);
			cache.at = Date.now();
		} catch {
			cache.at = Date.now();
		} finally {
			cache.loading = false;
		}
	};
	const kickIfStale = () => {
		if (cache.loading) return;
		if (Date.now() - cache.at < ttlMs) return;
		refresh();
	};
	kickIfStale();
	const dispose = ctx.systemPrompt.context({
		name: "router-collaboration",
		order,
		text: (assembly) => {
			kickIfStale();
			const sessionId = currentSessionId(assembly);
			if (sessionId === void 0) return diagnosticText(dataDir);
			return buildCollaborationContext({
				sessionId,
				dataDir,
				roles: cache.value
			});
		}
	});
	return () => {
		dispose?.();
	};
}

//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=context.js.map