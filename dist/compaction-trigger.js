import Schema from "@deepseek-ai/schemastery";

//#region src/compaction-trigger.ts
const name = "router-compaction-trigger";
/** 只要 compaction 服务；它由 isolate 组提供，本行必须在组内。 */
const inject = ["compaction"];
const Config = Schema.object({});
/** 子会话结束在父会话收件箱里的消息来源种类（宿主 SubagentSettledMessageSource.kind）。 */
const SUBAGENT_SETTLED_KIND = "subagent-settled";
/** 从事件载荷里取 agent.id；取不到返回 undefined（不臆造身份）。 */
function agentIdOf(agent) {
	if (typeof agent !== "object" || agent === null) return void 0;
	const id = agent.id;
	return typeof id === "string" && id !== "" ? id : void 0;
}
/** 从收件箱载荷里判断「这条消息是不是子会话结束的 notice」。 */
function isSubagentSettledMessage(payload) {
	if (typeof payload !== "object" || payload === null) return false;
	const message = payload.message;
	if (typeof message !== "object" || message === null) return false;
	const source = message.source;
	if (typeof source !== "object" || source === null) return false;
	return source.kind === SUBAGENT_SETTLED_KIND;
}
/**
* 注册两个监听器；返回注销器交给宿主 effect 生命周期。
* 整个 apply 包在一层 try 里：这一行在 compaction 组内，抛出去会让整棵预设树回滚，
* 代价远大于「自动压缩不工作」。
*/
function apply(ctx) {
	const pending = /* @__PURE__ */ new Set();
	const lifetime = new AbortController();
	const warn = (message) => {
		try {
			ctx.logger?.warn?.(message);
		} catch {}
	};
	const disposers = [];
	try {
		disposers.push(ctx.on("agent/inbox/inserted", (payload) => {
			if (!isSubagentSettledMessage(payload)) return;
			const agentId = agentIdOf(payload?.agent);
			if (agentId === void 0) return;
			pending.add(agentId);
		}));
		disposers.push(ctx.on("agent/turn-stopping", async (payload) => {
			const agent = payload?.agent;
			const agentId = agentIdOf(agent);
			if (agentId === void 0 || !pending.delete(agentId)) return;
			try {
				await ctx.compaction.compactNow(agent, lifetime.signal);
			} catch (error) {
				warn(`[router-compaction-trigger] 自动压缩未完成（已跳过）: ${error instanceof Error ? error.message : String(error)}`);
			}
		}));
	} catch (error) {
		warn(`[router-compaction-trigger] 监听器注册失败，自动压缩不生效: ${error instanceof Error ? error.message : String(error)}`);
	}
	return () => {
		for (const dispose of disposers) try {
			dispose();
		} catch {}
		lifetime.abort();
	};
}

//#endregion
export { Config, SUBAGENT_SETTLED_KIND, apply, inject, isSubagentSettledMessage, name };
//# sourceMappingURL=compaction-trigger.js.map