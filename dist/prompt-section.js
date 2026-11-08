import Schema from "@deepseek-ai/schemastery";

//#region src/prompt-section.ts
/** 本入口的插件名（诊断显示用）。 */
const name = "router-prompt-section";
const inject = ["systemPrompt", "routerCore"];
const Config = Schema.object({ order: Schema.number().default(50).volatile() });
/**
* 从组装上下文提取会话 id（形状防御：两代宿主 `agent.session.id` /
* `agent.id` 都兜住；取不到返回 undefined = 回落默认）。
*/
function sessionIdOfAssembly(assembly) {
	const agent = assembly?.agent;
	for (const candidate of [agent?.session?.id, agent?.id]) if (typeof candidate === "string" && candidate !== "") return candidate;
}
/** 注册 complete section；返回注销器交给宿主 effect 生命周期。 */
function apply(ctx, config) {
	const order = typeof config.order === "number" && Number.isFinite(config.order) ? config.order : 50;
	const dispose = ctx.systemPrompt.section({
		name: "router-prompt",
		order,
		complete: true,
		text: (assembly) => ctx.routerCore.sessionPromptText(sessionIdOfAssembly(assembly))
	});
	let done = false;
	return () => {
		if (done) return;
		done = true;
		dispose?.();
	};
}

//#endregion
export { Config, apply, inject, name, sessionIdOfAssembly };
//# sourceMappingURL=prompt-section.js.map