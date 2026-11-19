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
//#region src/collaboration/dispatch.ts
/** 派发方式：spawn 轻装自足 / fork 带父级已完成轮次。 */
const DISPATCH_MODES = ["spawn", "fork"];
/** 宿主 dsh-subagent.startActivation 内部第一行就 spec.signal.throwIfAborted()（非可选，
*  0.2.1 与 0.2.2 皆然），缺 signal 直接 TypeError。优先用调用方 turn 的 exec.signal；
*  缺席时兜底插件级 controller（同 agent-kernel D2），保证任何宿主下都传真实 AbortSignal。 */
const dispatchLifetime = new AbortController();
/** 拼装给子会话的初始指令：职责 + 任务 + 根会话 + 报告链要点（纯函数）。 */
function composeDispatchInstruction(input) {
	const duty = input.role.description.trim() === "" ? "（该角色模板未写职责说明）" : input.role.description.trim();
	return [
		`你是轻量团队协作中的「${input.role.name}」。`,
		"",
		"你的职责说明：",
		duty,
		"",
		"本次任务：",
		input.task,
		"",
		`根会话（rootSessionId）：${input.rootSessionId}——之后每次保存工作记录都必须显式带上它，不要用你自己的会话 ID 充当。`,
		"工作资料用记录工具保存（task/assignment/report/summary）；进度、问题与结果按报告链报给上级（worker→主管→Router→用户）。",
		"完成后保存报告记录（标注工作标签），并把结果与产物位置写清楚；不要等待额外系统确认。"
	].join("\n");
}
/** 构造 router_dispatch 工具定义。 */
function buildDispatchTool(deps) {
	return {
		name: "router_dispatch",
		description: "按角色派发子会话（职责注入由代码完成）。传入角色名（须已存在于角色库）、任务内容与派发方式；创建成功自动登记一条分工记录（关联子会话、待处理标签）。spawn=轻装新建（默认，材料自足）；fork=带父级已完成轮次（子会话能看到你的对话历史，令牌成本更高，确需任务背景时才用）。rootSessionId 是整棵任务树的根会话，必须显式传入。",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				rootSessionId: {
					type: "string",
					description: "根会话 ID（显式传入，不可推断）"
				},
				taskId: {
					type: "string",
					description: "归属任务的记录 ID（先用 router_record_create 建任务说明）"
				},
				role: {
					type: "string",
					description: "角色名（角色库中的名称，如 主管/执行者/调研员/评审员）"
				},
				task: {
					type: "string",
					description: "给该角色的任务内容（目标、约束、验收条件、材料位置）"
				},
				mode: {
					type: "string",
					enum: [...DISPATCH_MODES],
					description: "派发方式：spawn=轻装新建（默认）；fork=带父级已完成轮次（成本更高，确需背景才用）"
				}
			},
			required: [
				"rootSessionId",
				"taskId",
				"role",
				"task",
				"mode"
			]
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					childId: { type: "string" },
					record: {
						type: "object",
						additionalProperties: false,
						properties: {
							taskId: { type: "string" },
							recordId: { type: "string" },
							path: { type: "string" }
						}
					},
					recordError: { type: "string" }
				},
				required: ["childId"]
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		async execute(args, exec) {
			if (typeof args !== "object" || args === null || Array.isArray(args)) throw new CollaborationError("INVALID_INPUT", "参数必须是对象");
			const a = args;
			const rootSessionId = nonEmpty(a.rootSessionId, "rootSessionId");
			const taskId = nonEmpty(a.taskId, "taskId");
			const roleName = nonEmpty(a.role, "role");
			const task = nonEmpty(a.task, "task");
			const mode = a.mode;
			if (typeof mode !== "string" || !DISPATCH_MODES.includes(mode)) throw new CollaborationError("INVALID_INPUT", `mode 必须是 ${DISPATCH_MODES.join(" 或 ")}`);
			const provider = mode;
			const role = await deps.roles.read(roleName);
			if (deps.subagents === void 0) throw new CollaborationError("IO_ERROR", "subagents 服务不可用：无法创建子会话（检查宿主装载）");
			const parent = exec?.agent;
			if (parent === void 0) throw new CollaborationError("INVALID_INPUT", "router_dispatch 需要调用方 agent（exec.agent 缺失）");
			const execSignal = exec?.signal;
			const signal = execSignal instanceof AbortSignal ? execSignal : dispatchLifetime.signal;
			const instruction = composeDispatchInstruction({
				role,
				task,
				rootSessionId
			});
			const { childId } = await deps.subagents.startActivation({
				provider,
				label: `${role.name}·${taskId}`,
				request: {
					prompt: [{
						type: "text",
						text: instruction
					}],
					parent,
					maxDepth: 2
				},
				signal,
				delivery: "parent"
			});
			try {
				const saved = await deps.records.create(rootSessionId, {
					kind: "assignment",
					taskId,
					title: `${role.name}：${task.slice(0, 40)}`,
					body: instruction,
					workLabel: "待处理",
					sessions: [{
						sessionId: childId,
						label: role.name
					}]
				});
				return {
					childId,
					record: {
						taskId: saved.record.taskId,
						recordId: saved.record.id,
						path: saved.path
					}
				};
			} catch (error) {
				return {
					childId,
					recordError: `子会话已创建（${childId}），但分工记录登记失败：${error instanceof Error ? error.message : String(error)}——请用 router_record_create 补记并关联该子会话`
				};
			}
		}
	};
}
function nonEmpty(value, what) {
	if (typeof value !== "string" || value.trim() === "") throw new CollaborationError("INVALID_INPUT", `${what} 必须是非空字符串`);
	return value;
}

//#endregion
//#region src/collaboration/tools.ts
/** 参数包装必须是非空、非数组的对象，否则 INVALID_INPUT。 */
function asObject(value, what) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CollaborationError("INVALID_INPUT", `${what} 必须是对象`);
	return value;
}
/** 可选对象字段：省略合法；存在则必须是非空、非数组的对象。 */
function optionalObject(value, what) {
	if (value === void 0) return void 0;
	return asObject(value, what);
}
/** 必需原始字符串：非空字符串，否则 INVALID_INPUT。 */
function asNonEmptyString(value, what) {
	if (typeof value !== "string" || value.length === 0) throw new CollaborationError("INVALID_INPUT", `${what} 必须是非空字符串`);
	return value;
}
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
/** 保存结果：记录与实际落盘路径。 */
const SAVED_RECORD_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		record: RECORD_SCHEMA,
		path: {
			type: "string",
			description: "落盘路径"
		}
	},
	required: ["record", "path"]
};
/** 角色模板 schema。 */
const ROLE_TEMPLATE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		name: {
			type: "string",
			description: "角色名（=md 文件名）"
		},
		description: {
			type: "string",
			description: "职责说明"
		}
	},
	required: ["name", "description"]
};
/** render：输出与存储返回值一致的 JSON 文本（单文本块）。 */
function jsonRender(_args, value) {
	return [{
		type: "text",
		text: JSON.stringify(value)
	}];
}
/**
* 构建团队协作工具集。records/roles 为存储单实例，subagents 为宿主子代理服务
* （base 全局提供，缺席时派发工具明确报错、其余七条不受影响）。rootSessionId
* 始终显式传入；存储为字段校验的最终权威，本层只拦包装层坏值。
*/
function buildCollaborationTools(deps) {
	const { records, roles } = deps;
	return [
		buildDispatchTool(deps),
		{
			name: "router_record_create",
			description: "新建一条工作记录（任务说明 task / 分工 assignment / 工作报告 report / 汇总 summary）。rootSessionId 是整棵任务树的根会话，必须显式传入，不要拿当前会话 ID 充当根会话。空 body 合法，空 title 不合法。",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					rootSessionId: {
						type: "string",
						description: "根会话 ID（显式传入，不可推断）"
					},
					input: {
						type: "object",
						additionalProperties: false,
						description: "新建记录入参",
						properties: {
							kind: {
								type: "string",
								enum: [...RECORD_KINDS],
								description: "记录种类"
							},
							taskId: {
								type: "string",
								description: "归属任务 ID（非任务记录必填；任务记录会忽略并等于本次记录 ID）"
							},
							parentRecordId: {
								type: "string",
								description: "父记录编号（同任务内，可选）"
							},
							title: {
								type: "string",
								description: "标题（非空）"
							},
							body: {
								type: "string",
								description: "正文（可为空）"
							},
							workLabel: {
								type: "string",
								enum: [...WORK_LABELS],
								description: "工作标签（可选）"
							},
							sessions: {
								type: "array",
								description: "关联会话（可选）",
								items: SESSION_LINK_SCHEMA
							},
							artifacts: {
								type: "array",
								description: "成果引用（可选）",
								items: ARTIFACT_REF_SCHEMA
							}
						},
						required: [
							"kind",
							"title",
							"body"
						]
					}
				},
				required: ["rootSessionId", "input"]
			},
			output: {
				schema: SAVED_RECORD_SCHEMA,
				render: jsonRender
			},
			async execute(args) {
				const a = asObject(args, "参数");
				const rootSessionId = asNonEmptyString(a.rootSessionId, "rootSessionId");
				const input = asObject(a.input, "input");
				return records.create(rootSessionId, input);
			}
		},
		{
			name: "router_record_read",
			description: "按 rootSessionId + taskId + recordId 读取一条工作记录。",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					rootSessionId: {
						type: "string",
						description: "根会话 ID"
					},
					taskId: {
						type: "string",
						description: "任务 ID"
					},
					recordId: {
						type: "string",
						description: "记录 ID"
					}
				},
				required: [
					"rootSessionId",
					"taskId",
					"recordId"
				]
			},
			output: {
				schema: SAVED_RECORD_SCHEMA,
				render: jsonRender
			},
			async execute(args) {
				const a = asObject(args, "参数");
				const rootSessionId = asNonEmptyString(a.rootSessionId, "rootSessionId");
				const taskId = asNonEmptyString(a.taskId, "taskId");
				const recordId = asNonEmptyString(a.recordId, "recordId");
				return records.read(rootSessionId, taskId, recordId);
			}
		},
		{
			name: "router_record_list",
			description: "列举某根会话下的工作记录，可按 taskId 或 kind 过滤。无匹配返回空列表。rootSessionId 必须显式传入。",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					rootSessionId: {
						type: "string",
						description: "根会话 ID"
					},
					query: {
						type: "object",
						additionalProperties: false,
						description: "可选过滤条件",
						properties: {
							taskId: {
								type: "string",
								description: "只列该任务"
							},
							kind: {
								type: "string",
								enum: [...RECORD_KINDS],
								description: "只列该种类"
							}
						}
					}
				},
				required: ["rootSessionId"]
			},
			output: {
				schema: {
					type: "array",
					items: RECORD_SCHEMA
				},
				render: jsonRender
			},
			async execute(args) {
				const a = asObject(args, "参数");
				const rootSessionId = asNonEmptyString(a.rootSessionId, "rootSessionId");
				const query = optionalObject(a.query, "query");
				return records.list(rootSessionId, query);
			}
		},
		{
			name: "router_record_update",
			description: "更新一条记录的标题/正文/工作标签/关联会话/成果引用。种类、归属（taskId/rootSessionId）与创建时间不可更新。",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					rootSessionId: {
						type: "string",
						description: "根会话 ID"
					},
					taskId: {
						type: "string",
						description: "任务 ID"
					},
					recordId: {
						type: "string",
						description: "记录 ID"
					},
					patch: {
						type: "object",
						additionalProperties: false,
						description: "更新补丁（只含可改字段）",
						properties: {
							title: {
								type: "string",
								description: "新标题（非空）"
							},
							body: {
								type: "string",
								description: "新正文"
							},
							workLabel: {
								type: "string",
								enum: [...WORK_LABELS],
								description: "新工作标签"
							},
							sessions: {
								type: "array",
								description: "新关联会话",
								items: SESSION_LINK_SCHEMA
							},
							artifacts: {
								type: "array",
								description: "新成果引用",
								items: ARTIFACT_REF_SCHEMA
							}
						}
					}
				},
				required: [
					"rootSessionId",
					"taskId",
					"recordId",
					"patch"
				]
			},
			output: {
				schema: SAVED_RECORD_SCHEMA,
				render: jsonRender
			},
			async execute(args) {
				const a = asObject(args, "参数");
				const rootSessionId = asNonEmptyString(a.rootSessionId, "rootSessionId");
				const taskId = asNonEmptyString(a.taskId, "taskId");
				const recordId = asNonEmptyString(a.recordId, "recordId");
				const patch = asObject(a.patch, "patch");
				return records.update(rootSessionId, taskId, recordId, patch);
			}
		},
		{
			name: "router_role_list",
			description: "列出全部角色模板（专业类型）。dispatch/派发专业类型时只从这里选，不要凭记忆或猜测。",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {}
			},
			output: {
				schema: {
					type: "array",
					items: ROLE_TEMPLATE_SCHEMA
				},
				render: jsonRender
			},
			async execute(args) {
				if (args !== void 0) asObject(args, "参数");
				return roles.list();
			}
		},
		{
			name: "router_role_read",
			description: "按编号读取一个角色模板。",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: { name: {
					type: "string",
					description: "角色名（=md 文件名）"
				} },
				required: ["name"]
			},
			output: {
				schema: ROLE_TEMPLATE_SCHEMA,
				render: jsonRender
			},
			async execute(args) {
				const name$1 = asNonEmptyString(asObject(args, "参数").name, "name");
				return roles.read(name$1);
			}
		},
		{
			name: "router_role_save",
			description: "创建或修改角色模板（按名 upsert：同名覆盖职责说明）。角色模板是职责文本，一个角色一个 md 文件（文件名 = 角色名），可直接手工编辑。",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: { input: {
					type: "object",
					additionalProperties: false,
					description: "模板入参",
					properties: {
						name: {
							type: "string",
							description: "角色名（非空；同名即更新）"
						},
						description: {
							type: "string",
							description: "职责说明"
						}
					},
					required: ["name", "description"]
				} },
				required: ["input"]
			},
			output: {
				schema: ROLE_TEMPLATE_SCHEMA,
				render: jsonRender
			},
			async execute(args) {
				const input = asObject(asObject(args, "参数").input, "input");
				return roles.save(input);
			}
		}
	];
}

//#endregion
//#region src/tools.ts
/** 本入口的插件名（诊断显示用；装载行的 name 是带子路径说明符）。 */
const name = "router-tools";
const inject = [
	"tools",
	"routerCollaboration",
	"subagents"
];
/**
* 行配置：无。保留 Config（空对象）以与宿主行校验一致（check-host-rows 对无 config 行
* 按「跳过校验」处理，但导出 Config 让形状显式、可测）。
*/
const Config = Schema.object({});
/** 注册八条协作工具；返回联合注销器交给宿主 effect 生命周期。disposal 干净。 */
function apply(ctx) {
	const disposers = buildCollaborationTools({
		records: ctx.routerCollaboration.records,
		roles: ctx.routerCollaboration.roles,
		subagents: ctx.subagents
	}).map((definition) => ctx.tools.register(definition));
	return () => {
		for (const dispose of disposers) dispose?.();
	};
}

//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=tools.js.map