import Schema from "@deepseek-ai/schemastery";

//#region src/context.ts
/** 本入口的插件名（诊断显示用）。 */
const name = "router-context";
const inject = ["systemPrompt", "routerCore"];
const Config = Schema.object({ order: Schema.number().default(100).volatile() });
/** 注册快照上下文；返回注销器交给宿主 effect 生命周期。 */
function apply(ctx, config) {
	const order = typeof config.order === "number" && Number.isFinite(config.order) ? config.order : 100;
	const dispose = ctx.systemPrompt.context({
		name: "router-task-ledger",
		order,
		text: () => ctx.routerCore.snapshotText()
	});
	return () => {
		dispose?.();
	};
}

//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=context.js.map