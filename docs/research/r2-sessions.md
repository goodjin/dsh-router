# DSH 会话生命周期与跨会话交互宿主契约调查报告（r2-sessions）

调查时间：2026-11-07。只读研究，未修改任何现有文件。

## 0. 资料源与核对基准

- 权威实现：桌面版 `dsh 0.2.2-rc.1`。`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 是单一 Electron 归档文件（213MB），`node_modules/@deepseek-ai/*` 全部在归档内部。已用 `@electron/asar`（本机 npx 缓存）**整体解包到 `/tmp/dsh-asar-22/`**。下文所有 `asar:` 路径行号均指 `/tmp/dsh-asar-22/dsh/node_modules/@deepseek-ai/<包名>/lib/…` 内的行号（解包忠实还原归档内容，行号即权威源行号）。
- typert 注册表（各包 `lib/typert.host.js`）内嵌 `sourceLocation` 字段，直接给出 monorepo 源文件与行号（如 `packages/api/session-controller/src/index.ts:465`），下文以 `→ src:` 标注。
- 文档镜像：`/Users/good/github/dsh-plugins/docs/official/reference/subsystems/`（dsh-v0.2.2-rc.1 逐字节镜像）。
- 实证插件：`/Users/good/github/dsh-plugins/dsh-auto-resume`（纯宿主侧投递样本）、`dsh-acp-agent`（辅助）。
- CLI 侧另有一份 `@deepseek-ai/dsh@0.2.1-rc.2` 全局安装（`/Users/good/.local/share/node-v24.18.1-darwin-arm64/lib/node_modules/@deepseek-ai/`），仅作旁证；全部结论以 0.2.2-rc.1 解包源为准。

---

## 1. 从宿主插件代码创建一个新的独立根会话

### 1.1 确切服务与方法

**推荐入口：`ctx.sessionController.create(request, signal?)`**（服务名 `sessionController`，Remote 端点 `session/create`）。

- 服务注册：`asar:dsh-api-session-controller/lib/index.js:3791` — `super(ctx, "sessionController", { namespace: "session" })`（typert-protocol 的 Service 基类，见 `asar:dsh-typert-protocol/lib/index.js:322-338` 的 `bindTypertRemote`：服务键即 Cordis 键，namespace 是 wire 命名空间）。
- 命令注册：`asar:dsh-api-session-controller/lib/typert.host.js:1987` `'session/create'` → src: `packages/api/session-controller/src/index.ts:304`。
- **方法名（宿主直调形态）是裸方法名 `create`**，wire 端点名才是 `session/create`。同一 registry 里 `session/prompt` ↔ 宿主方法 `prompt(request, signal)`，auto-resume 已实证（见 §2）。
- 请求参数（strict schema，`typert.host.js:1987-2016` 内 jsonSchema）：
  - `workspaceId?: string` — 会话加入的 Workspace，**与 `cwd` 互斥**；
  - `cwd?: string` — 未命名 workspace 时会话拥有的目录；
  - `sessionId?: string` — 复用仍空白的会话；也允许指定一个全新 id；
  - `agentPreset?: string` — 会话运行的预设；缺省用部署默认预设。
  - **没有 `title` 参数**——标题走 `session/rename`（`typert.host.js:2415` → src: `.../src/index.ts:434`）或自动标题插件（`session/title` 事件，见 §3.3）。
- 返回：`{ sessionId: string, agentPreset?: string }`（可能返回与请求不同的 sessionId，因为空白会话可被复用）。

**实现链**（`asar:dsh-api-session-controller/lib/index.js`）：
- `SessionCommandController.create(request)`：666 行起。校验 `workspaceId` XOR `cwd`（664）；`cwd = workspace.path ?? request.cwd ?? defaultCwd`（668）；调 `this.agents.createSession({...})`（676，`agents` 是内部 `ApiSessionAgentController`，3802 行构造）；命中 workspace 时 `await workspace.attachSession(sessionId)`（687）。
- 底层再往下是 `ctx.agents.create(options)` / `ctx.sessions`（会话存储，`asar:dsh-session/lib/index.js:1748` `super(ctx, "sessions")`）与 agent-loop 工厂（`asar:dsh-agent/lib/index.js:427-434` 注释：Agent *creation* 由实现 `AgentFactory` 的 `@deepseek-ai/dsh-agent-loop` 经 `setFactory` 提供，`asar:dsh-agent/lib/index.js:558-566`；`ctx.agents.create(options)` 在 582 行）。**插件不应直接走这一层**——preset 解析、空白复用、workspace 挂靠都在 sessionController 里。
- 复用语义（README `asar:dsh-api-session-controller/README.md:48`）：命名的 `sessionId` 在「仍空白、属于请求目录、是请求 Workspace 的未归档成员、无其他 owner 写入」时被原位复用（live 就地复用，持久化的保持 writer lock 复用）；已开轮次/目录冲突/他者持有则新建。

### 1.2 创建后如何出现在 workspace 侧栏

两条路：

1. **显式 `workspaceId` 创建**：`session/create` 内部 `workspace.attachSession(sessionId)`（`asar:dsh-api-session-controller/lib/index.js:685-689`；`asar:dsh-workspace/lib/index.js:111-133` 的 `attachSession`：校验会话 header.cwd realpath 等于 workspace.path 后前插 `sessionIds`）。这是唯一在创建时同步入册的路径；不存在 `addSession`/`upsert` 命令——workspace-controller 的 Remote 命令只有移动/归档/置顶（见 §5）。
2. **裸 `cwd` 创建**：运行期不入册；侧栏分组依赖 (a) 启动时 `WorkspaceRegistry[Service.init]` → `bootstrap(headers)`（`asar:dsh-workspace/lib/index.js:390, 758-831`）按会话 cwd 路径自动归组，(b) `indexLiveSessions()`（900-904 行，从 `ctx.sessions.list()` 收 header）。重启后自动归入同路径 workspace。

侧栏的实时投影：客户端经 `workspace/follow` 流（baseline + `upsert/remove/order/archived/pinned` 增量，`asar:dsh-api-workspace-controller/README.md` Summary 与 Use-this-package 段）+ `session/list`（`typert.host.js:2133`，"Read all visible Session rows without resuming an Agent"）。

### 1.3 dsh-auto-resume 是否创建过会话？

**否。** 全仓 `src/` 只有扫描与投递（`src/scan.ts`、`src/deliver.ts`），无任何 create 调用；inject 列表 `['sessionQuery', 'agents', 'workspaceRegistry', 'sessionController']`（`src/index.ts:29`）中 `agents` 只用于 `agents.get(id)?.status` 查存活（`src/scan.ts:20, 123-124`）。

### 1.4 UI 客户端创建会话走哪条命令？

同一条 Gateway 端点 `session/create`：侧栏「New Session」按钮以 `useRemoteAccess("session/create")` 做权限门控（`asar:dsh-client-ui-sidebar/lib/client.js:57, 299`；workspace UI 同样门控 `asar:dsh-client-ui-workspace/lib/client.js:2191, 2204`），经生成的 client Remote namespace（`session.create`，client 契约在 `asar:dsh-api-session-controller/lib/client.js`，README.md:48 明言 "`session.create` returns a Session for a new conversation"）发起。

---

## 2. 向「非自己子级」的已有会话投递用户消息

### 2.1 确切 API：`ctx.sessionController.prompt(request, signal)`

- 命令注册：`asar:dsh-api-session-controller/lib/typert.host.js:2382` `'session/prompt'` → src: `packages/api/session-controller/src/index.ts:465`。
- Remote 包装层（`asar:dsh-api-session-controller/lib/index.js:4048-4063`）：
  1. `signal.throwIfAborted()` — **第一行就要求 AbortSignal**（auto-resume 实测缺了它直接 TypeError，`dsh-auto-resume/src/deliver.ts:96-97` 注释）；
  2. 内容校验：至少一个非空白 text 或附件，否则 `gateway/bad-request`；
  3. 构造持久化 user 源：`source = { kind: "user", rpcId: request.requestId, clientTimeZone?, principal? }`（4056-4060）。宿主内直调时 `ctx.invocation` 为 undefined → `principal` 缺省 = owner 身份（`asar:dsh-typert-protocol/lib/index.js:344-349` `provideInvocationAccessor`：非 Remote 调用读作 undefined）。
- admission 核心（`lib/index.js:831-897` `SessionCommandController.prompt`）：
  - `await this.resolveAgent(request.sessionId)` — **冷会话显式 resume**（README.md:36 "prompt ... may resolve or resume an ordinary Session"）；
  - **requestId 幂等**：`hasPromptRequest(agent, request.requestId)` 命中（已排队或已入账）时直接返回原受理 `{accepted:true}`，不重复插消息（833 行；README.md:36 "Prompt retries whose requestId is already queued or logged return the original acceptance"）；
  - `request.mode === "steer"` → `agent.steer(message)`；**其余一切值（含 auto-resume 传的 `'followup'`）→ `agent.followup(message)`**（857-858 行）。wire strict schema 的枚举是 `["queue","steer"]`（typert.host.js:2382 jsonSchema），但宿主直调不过 wire codec，故 `'followup'` 这样的非枚举值也落到 followup 分支——auto-resume 正是靠这个工作（`src/deliver.ts:29, 115`）。**给自己的插件：稳妥写 `mode: "queue"` 或 `"steer"`。**
  - 失败折成 `session/agent-busy`（875-878）。

### 2.2 请求 schema（typert.host.js:2382 jsonSchema）

```
{
  requestId: string,      // 客户端自造 id，持久化在最终被受理的 user 消息上
  sessionId: string,
  mode: "queue" | "steer",
  content: [ {type:"text",text} | {type:"image",mediaType,data,name?} | {type:"file",receiptId} ],
  clientTimeZone?: string
}
```
返回 `{ accepted: true }`。

### 2.3 排队 / steer / 空闲唤醒 / 持久化

- `agent.followup(input)` = `send(input, "next-turn", wakeup=true)`；`agent.steer(input)` = `send(input, "next-step", wakeup=true)`（`asar:dsh-agent-loop/lib/index.js:570-575`）。
- `send`：插入 inbox（`inbox.splice(target, …)`）后 `wakeDriver`（560-568）。`wakeDriver`（618-630）：**空闲 → 立即开新轮次并 kick 循环；运行中 → 只 latch `wakeRequested`，当前活动结束后补跑**。中断后的唤醒 send 会改派为 `next-turn`（560-562）。
- **持久化**：每次 send 追加持久化会话事件 `agent/inbox/spliced`（`asar:dsh-agent-loop/lib/index.js:198`；事件在已知类型表 `asar:dsh-session/lib/types/known-event-types.js:23`）。被受理的 user 消息本身以 `source.kind:"user"`（`user-rpc`，rpcId=requestId）入账（`asar:dsh-api-session-controller/lib/index.js:860-861` `createUserMessage` + README.md:38）。**因此宿主崩溃后未投递的排队消息可从日志重放**——auto-resume 把 `queued` 列为一种可继续的中断原因（`src/deliver.ts:54-55`）。
- 已受理排队项的编辑/删除/改道：`session/updateQueue`（`typert.host.js:2545` → src: `src/index.ts` 846-946 区段实现，action: edit/remove/steer）。

### 2.4 sendMessage / SubagentRuntime 只限相邻代理

- `subagents/prompt`（`asar:dsh-subagent/lib/typert.host.js:132-134`）："Deliver one browser-authored message to a continuable child **through the exact live direct parent**"；queue→下轮，steer→最近 step；冷恢复超容量拒绝 `subagent/delivery-unavailable`。
- `subagents/steer`（同文件 216-238 区段 jsDoc）：目标只能是 **direct parent 或 direct continuable child**，"adjacency is rejected"。
- `subagents/interruptByParent`（66-131 区段）：`UNAUTHORIZED` — "subagent does not belong to this parent"（`lib/index.js:80`）。
- **结论：跨会话（非父子）投递的正解就是 §2.1 的 `sessionController.prompt`**；subagent 通道不适用。

### 2.5 auto-resume 的「继续投递」实证

`ctx.sessionController.prompt({ requestId: uuid(), sessionId, mode: 'followup', content: [{type:'text', text}] }, AbortSignal.timeout(120_000))`（`dsh-auto-resume/src/deliver.ts:24-34, 110-119`；注入面 `src/index.ts:29, 33`）。顺序投递 + 目标间 stagger（`deliver.ts:74-89`）。

---

## 3. 观察任一会话的运行状态

### 3.1 事件订阅（全局即可，无需 per-session）

两套词汇，宿主插件都能 `ctx.on` 直接收：

**底层 agent 词汇**（scoped 分发，但**未加 scope 的全局监听者对所有分发都放行**，见 §4.3 的 scope 语义）：
- `agent/status` — payload `{ agent, status }`，status ∈ AgentStatus（idle/running 等每次迁移都发；`asar:dsh-agent-loop/lib/index.js:553-555` 在 `setPhase` 里 `dispatch.emit("agent/status", { status })`；文档镜像 `core.md:1024-1038` `'agent/status'(this: Scoped<Agent>, payload: { agent: Agent; status: AgentStatus }): void`）。
- `agent/created`（serial，payload `{agent, source, signal?}`）/ `agent/disposed`（emit，payload `{agent}`）— `core.md:801-841`；registry 侧 `asar:dsh-agent/lib/index.js:640-656`（register 时 announce "startup"、dispose 时发 `agent/disposed`）。
- status 判定：`get status()` — phase 为 idle/maintenance → `"idle"`，否则 `"running"`（`asar:dsh-agent-loop/lib/index.js:549-551`）。

**会话级聚合词汇**（session-controller 在宿主 ctx 上 `ctx.emit` 的全局事件，`asar:dsh-api-session-controller/lib/index.js:3825-3845`）：
- `session/created` → `api-session/added`（summaryFor(session)）；`session/disposed` → `api-session/removed`；
- `agent/status` → **`api-session/status` `(sessionId, running: boolean)`**（3836-3838 行）——**这就是插件订阅任意会话「开始/结束运行」的最省事事件**；
- `agent/error` → `api-session/error` `(sessionId, message)`；
- user 消息入账 → `api-session/activity` `(sessionId, time)`。
- 这些事件也在 api-remotes 的转发白名单里（`asar:dsh-api-remotes/lib/index.js:46-60`），浏览器侧可用 `ctx.remote.$on` 收。

### 3.2 查询当前 running/idle

- **查内存活体**：`ctx.agents.get(sessionId)?.status`（`asar:dsh-agent/lib/index.js:725-726` get；status 见上）。auto-resume 即此用法（`src/scan.ts:20, 123-124`）。
- **Remote 查询**（不激活 cold agent）：
  - `session/list`（`typert.host.js:2133`）— 全部可见会话行（含 running 提示），"without resuming an Agent"；
  - `session/state`（`typert.host.js:2512`，请求 `{sessionId}`）→ `{cursor, active, running, queue, pendingInput}`，`pendingInput ∈ ('approval'|'question'|'other')[]`；
  - `session/wait`（`typert.host.js:2577`，请求 `{sessionId, timeoutMs, afterSeq?, maxMessages?}`）→ `{reason: 'idle'|'input-required'|'timeout', state}` — **等会话安静或等输入的阻塞式查询**，适合「观察其结束」；
  - `session/observeState`（流，`typert.host.js:2249`）— 完整 state 替换流。

### 3.3 标题与持久化目录

- **标题**：持久化事件 `session/title`（`asar:dsh-session-title/lib/index.js:308, 480` append；折叠投影 177, 189）。查询走 `ctx.sessionQuery.readTitle(sessionId)`（§6）或 `session/rename` 改写（§5）。
- **持久化目录**：运行时权威路径 `ctx.get('sessionPersistence')?.stat(id)` → `stat.location.path`（auto-resume 用法 `src/scan.ts:23, 143-148`）。物理布局（本机 `~/.dsh/sessions/` 实测）：`${DSH_HOME}/sessions/<cwd 长横线 slug>/`（如 `--Users-good-github-dsh-plugins--/`），文件为 `<sessionId>.jsonl` 或 `.jsonl.zstd`（`asar:dsh-session-persistence-jsonl/lib/index.js:750-753` 后缀规则）。
- 会话 header 字段：`{ id, cwd?, origin?, parentSession? }`（`asar:dsh-session/lib/types/index.js:52-53, 999-1001`；auto-resume 的最小面 `src/scan.ts:27-34`）。**子代理识别：`header.origin === 'subagent' || header.parentSession !== undefined`**（`src/scan.ts:119-121`）。

---

## 4. user-questions 瀑布：跨会话接问题与回答案

### 4.1 注册方式

```ts
// 插件 apply(ctx) 里，宿主上下文（未加 scope）= 全局监听，收所有会话：
ctx.on('user-questions/request', async (request, next) => {
  // request: AskUserQuestionRequestEvent { questions, agent?, signal?, wait? }
  // this: Scoped<Agent>（分发作用域）；this.scope / carrierKey 可判来源
  if (!mine(request)) return next()      // 委托给后续监听者
  return { answers: [...] }              // 返回答案 = 认领
})
```
- 事件与签名：文档镜像 `user-questions.md:285-300`（waterfall 模式，"Return an answer to claim the request or call `next()` to delegate. Scope-filtered dispatch：agent-scoped listeners receive only that agent"）；源 `packages/interaction/user-questions/src/types.ts`。
- 宿主内现成样板（SDK 桥）：`asar:dsh-sdk-jsonrpc-server/lib/index.js:165-171` — `ctx.on("user-questions/request", async (request, next) => { …; if (!ownsAgent(agent)) return next(); return this.ask(...) })`。

### 4.2 认领语义与顺序

- 分发实现：cordis `waterfall`（`asar:cordis/lib/index.js:899-915`）：**监听者按注册序外层先跑**（`_resolve` 保持 hooks 数组顺序，829-835 行；`register` 默认 push、`options.prepend` 可 unshift，916-925 行）；**返回答案而不调 `next()` = 认领并否决链上其余人**（包括内建的 `noAnswerer` 兜底）；调 `next()` = 委托。全部委托到内建则 `NO_PROVIDER`（`asar:dsh-user-questions/lib/index.js:707` noAnswerer）。
- **客户端兜底 UI 也是同一个瀑布上的一个监听者**：api-remotes 把 `user-questions/request` 以 waterfall 模式桥给 Gateway 队列（`asar:dsh-api-remotes/lib/index.js:144-145` 转发白名单；173-180 注册监听；241-258 `forwardWaterfall`：推入队列等客户端作答，客户端不认（outcome 非 result）才 `next()`）。**它只转发 agent 作用域分发**——`carrierAgent = carrierKeyOf(this)` 为 undefined（全局分发）时直接 `next()`（174-176 行）。
- **谁先**：注册序。api-remotes 是宿主内建、随 web 栈启动装载；普通 profile 插件通常后注册 → **问题先到客户端 UI，插件后收到**。要抢在客户端兜底 UI 之前，用 `ctx.on(name, listener, { prepend: true })`（cordis `on` 的 options.prepend，`asar:cordis/lib/index.js:951-956` + `register` 920-925）。注意抢答意味着用户在 GUI 上看不到问题卡片。
- 浏览器侧监听形态：`dsh-client-ui-user-questions`（`asar:dsh-client-ui-user-questions/lib/client.js`）经 `ctx.remote.$on('user-questions/request', …)`。

### 4.3 scope 语义（全局 vs agent 作用域）

- ask() 的分发（`asar:dsh-user-questions/lib/index.js:709`）：
  - `request.agent === undefined` → `this.ctx.waterfall("user-questions/request", request, noAnswerer)` — **全局分发**；
  - 有 agent → `this.ctx.waterfall(scopeTarget(agent, agent), "user-questions/request", {…request, agent}, noAnswerer)` — **agent 作用域分发**（agent 本身是路由 key）。
- 路由规则（`asar:dsh-scope/lib/index.js:327-344` `scopeTarget` + 234-241 注释）：**注册时的 scope 标签在分发 key 或其祖先链上的监听者放行；未加标签（全局）的监听者对任何分发都放行；标签在 key 之下（后代）的收不到**——事件只沿链向上，不向下。所以：
  - **插件在宿主根 ctx 注册一个全局监听 = 能接住所有会话（含独立根会话）的提问**；
  - 只关心某个 agent：在 `agent.ctx`（agent 的 scoped ctx，agent-loop `createScope(loopCtx, this)`，`asar:dsh-agent-loop/lib/index.js:544`）上注册。
- ask-user 工具总是带 `agent: exec.agent` 调 ask（`asar:dsh-tool-ask-user/lib/index.js:186-196, 305-311`）→ 实际分发几乎总是 agent 作用域。

### 4.4 独立根会话 vs 被持有子会话：限制的是 ask()，不是瀑布

- **`assertLiveRoot(agent)`（`asar:dsh-user-questions/lib/index.js:539-543`）只在 `ask()`/`askTimed()` 入口、且调用方提供了 agent 时执行**（680 行 `if (agent !== void 0) this.assertLiveRoot(agent)`；askTimed 605 行同）：
  - `CALLER_NOT_LIVE`：提供的 agent 不是注册表里那个**精确存活实例**（`agents.get(agent.id) !== agent`）；
  - `DELEGATED_CALLER`：该存活 agent **不在 `agents.roots()`**（`asar:dsh-agent/lib/index.js:752-755`：owner 为 undefined 才是 root；"runtime ownership, not durable session lineage… a resumed fork may still be a root"）→ 被持有子代理没有人类答题通道，问题应并入其最终结果。
- **瀑布分发本身不受这两个码限制**——它们在分发前抛出。插件自己做跨会话问答时不受此约束；但要替「被持有的子会话」接问题，前提仍是那个子 agent 能发起 ask（发起不了就没有瀑布事件）。
- README 原文同义：`user-questions.md:258-274`（ask 的 jsDoc）。

### 4.5 回传答案的三条路（给独立 worker 会话）

1. **在瀑布里认领**（§4.1/4.2）——答案直接作为工具结果回到等待中的 ask_user，体验最好；前提是你能在客户端 UI 之前注册或客户端不答。
2. **迟复/已 continued 的问题**：`ctx.userQuestions.answer(agent, callId, answer)` — 把答案 steer 成一条 `user-question-reply` 源的 user 消息并在空闲时唤醒；开放或未知调用返回 false；重复回复 `REPLY_QUEUED`；批次不符 `BAD_ANSWER`（`asar:dsh-user-questions/lib/index.js:556-574` jsDoc + 实现；文档 `user-questions.md:185, 213-242`）。
3. **普通新轮次回话**：`sessionController.prompt`（§2）——适用于问题已 continued 且你只想以普通消息把答案递回去。

---

## 5. workspace 模型：列出 / 标题 / 归档 / 置顶

宿主服务两层：
- **`ctx.workspaceRegistry`**（`asar:dsh-workspace/lib/index.js:375-378` `super(ctx, "workspaceRegistry")`）— 直接操作面：
  - `list()` 454 / `get(id)` 445 / `delete(id)` 469 / `insertBefore(id, beforeId)` 479（registry 顺序）
  - `create(path, title)` 405（按 canonical path 幂等创建/解析）
  - `archiveSession(sessionId, options)` 526 / `unarchiveSession(sessionId)` 553（全局归档集 `archivedSessionIds` getter 506-508；归档不动会计）
  - `pinSession(sessionId)` 578 / `unpinSession(sessionId)` 598（pin 集，最近置顶在前）
  - `insertSessionBefore(sessionId, beforeSessionId)` 130（workspace 内移动，只动已入册会话）
  - 活动会话归档会被拒：`WorkspaceActiveSessionError`（314-316）。
- **`ctx.workspaceController`**（Remote 面，`asar:dsh-api-workspace-controller/lib/index.js:857` `super(ctx, "workspaceController", { namespace: "workspace" })`）— 命令（`lib/typert.host.js`）：
  - `workspace/create` 376（→ src: `packages/api/workspace-controller/src/index.ts:91`）`{path}`；
  - `workspace/follow` 440（→ src: 206）流式 baseline + `upsert/remove/order/archived/pinned` 增量（README Use-this-package 段）；
  - `workspace/insertSessionBefore` 505（→ src: 150）`{workspaceId, sessionId, beforeSessionId?}`；
  - `workspace/archiveSession` 344（→ src: 160）`{sessionId, stopActivity?}` — `stopActivity: true` 先停运行中的 turn/subagent/job/schedule 再归档；否则活动会话拒绝 `workspace/session-active`（README Use-this-package 段）；
  - `workspace/unarchiveSession` 601 / `workspace/pinSession` 537（→ src: 180） / `workspace/unpinSession` 633 / `workspace/rename` 569 / `workspace/delete` 408 / `workspace/initializeDefault` 457（→ src: 104，固定 `default-workspace` 目录名）。

**改标题**只有 `workspace/rename`（workspace 标题）与 `session/rename`（会话标题，§1.1）；会话标题另有自动标题链（`session-title` 事件）。

---

## 6. 会话语料枚举：session-query

- **注册名就是 `ctx.sessionQuery`**。基座（精确读/过滤/谱系）：`SessionQueryEngine`，`super(ctx, "sessionQuery")`，`static inject = ["sessions"]`（`asar:dsh-session-query/lib/index.js:1042-1048`）。文档目录：`session-query.md:375-509`。
- 关键签名（`session-query.md:379-509` cordis-catalog；实现在 `asar:dsh-session-query/lib/index.js`）：
  - `listSessions(signal?) → Promise<SessionRecord[]>`（newest-first 克隆记录；1064-1073 行；record.header 带 `id/cwd/origin/parentSession`）
  - `observeSession(sessionId, options?) → Promise<SessionObservation>`（**caller 持有的观察租约，含完整事件流，可 `Symbol.dispose`**；auto-resume 用法 `src/scan.ts:18, 37-39, 132-137`）
  - `readSession(sessionId) → SessionLogSnapshot`（不激活的整读）
  - `filterSessions(filters, signal?)` / `listEvents(sessionId)` / `readEvent(request, signal?)` / `readSurface(sessionId)`
  - `readTitle(sessionId, signal?) → SessionTitleSnapshot | undefined` / `readTitleSnapshot(s)`
  - `traceSession(sessionId, signal?)`（谱系）/ `traceEvent(...)`
  - 全文搜索（abstract，需后端）：`searchSessions(request, exec?)` / `searchEvents(request, exec?)`
- **SQLite provider**：`@deepseek-ai/dsh-session-query-sqlite` — "Concrete SQLite owner of the combined `ctx.sessionQuery` service"（`asar:dsh-session-query-sqlite/lib/index.js:475-477`，`static inject = ["sessions"]`）。**启用条件：显式挂载该包并给配置**（README.zh「最小配置」：`name: '@deepseek-ai/dsh-session-query-sqlite'` + `config.path: <专用索引db>`）。配置键（README.zh 配置表）：`path`（必填，勿指向 session-persistence 库）、`openAt`（`startup`|`first-search`|`never`，默认 startup）、`journalMode`（wal）、`defaultLimit` 20、`maxLimit` 100、`snippetChars` 240、`readWindowMax` 50、`persistedReadConcurrency` 4、`preparedSessionCacheSize` 5。未挂载时精确读/过滤仍可用（基座提供），仅全文搜索缺席。另有工具面 `dsh-tool-session-query`。
- `session/search`（sessionController 的 Remote 全文搜索，`typert.host.js:2447`）依赖该 provider。

---

## 7. 压缩：compaction

### 7.1 服务与跨插件调用可行性

- **seam**：`ctx.compaction` = `CompactionEngine`（抽象能力 seam，`compaction.md:141-208`；源 `packages/compaction/compaction/src/index.ts`）。**每 ctx 装载一个实现**（`compaction.md:145` "Load one implementation per context as `ctx.compaction`"）；`dsh-compaction-basic` 是标准后端。
- **另一个插件可以对指定会话调用**——前提：目标会话的 agent 是存活 idle（compactNow 语义），且你的 ctx 能看到同一个 `ctx.compaction`（同一宿主进程内即可，服务是宿主级注册）。签名（`compaction.md:147-204`）：
  - `compactIfNeeded(agent, trigger: 'pressure'|'context-overflow', signal)` → `CompactionResult | null`
  - **`compactNow(agent, signal, sourceCommandId?)`** → `CompactionResult | null` — 空闲会话强制压一次；作为 agent maintenance 运行；无有效范围返回 null 不写；失败码 `ManualCompactionErrorCode`：`busy/cancelled/changed/summary/commit/persistence`（`compaction.md:82-99`）
  - **`compactRegion(start, end, agent, signal?)`** → `CompactionResult` — 显式两端含 surface span（按 surface 位置非 seq 数值序），边缘必须工具配对平衡；活跃/缺失/倒序/不平衡都会抛
  - 结果 `CompactionResult{compactionId, startSeq, summarySeq, endSeq, summary, shadowedRange, shadowedSeqs, shadowedTokenCount}`（`compaction.md:42-70`）。
- 持久化事件（仅日志不进 surface）：`compaction/start|summary|end`（`compaction.md:11-21`）；替换消息用 `compactCheckpointSource` 构造（`@deepseek-ai/dsh-compaction/checkpoint` 子路径）。
- 压力压缩挂在 `agent/pre-step` 瀑布自动运行（`compaction.md:99`）。

### 7.2 compaction-basic 配置键（README.zh.md:60-76 配置表，文件 `asar:dsh-compaction-basic/README.zh.md`）

| 键 | 默认 | 含义 |
|---|---|---|
| `thresholdRatio` | 0.8 | 触发阈值 `floor(min(W×ratio, W−O−headroomTokens))` 的窗口比例 |
| `headroomTokens` | 65536 | 输出预留外余量 |
| `retainRatio` | 0.16 | 近期对话逐字保留比例（对 `W−O`）；与 `retainTokens` 互斥 |
| `retainTokens` | — | 保留的绝对预算（互斥，须低于阈值） |
| `summarizationProvider` / `summarizationModel` | `''` | 摘要模型对；空则用最近路由目标，再回退 AgentOptions |
| `maxTokens` | =headroom | 摘要输出上限 |
| `compactionRetries` | 1 | 压后仍超阈值的追加次数 |
| `maxOverflowRetries` | 1 | 确认溢出后的最大恢复次数 |
| `modelPolicies` | `[]` | 按 `{provider, model}` 的部分覆盖 |
| `auto` | `true` | false = 只手动 |

### 7.3 自定义摘要 = 一次 `ctx.llm.stream` 调用

compaction-basic 的样板（`asar:dsh-compaction-basic/lib/index.js:288-330` `summarizeWithLlm`）：
- 目标解析：配置对 → 最近已路由请求头 → AgentOptions（295-306）；都没有则抛错。
- 消息 = **重放会话前缀（system/tools/lead messages）+ 追加一条 compaction 指令 user 消息**（307-313，指令文本 275-280 区段），以复用 provider 前缀缓存。
- 调用选项：`{ provider, model, messages, toolHistory: session.toolHistory(), tools?, maxTokens, sessionId, purpose: "compaction", signal }`（314-322）；
- 消费：`for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)`（**323 行**）；产出 text-only summary blocks + `rawOutput` + **`llmStreamCall: true`** 标记 + provider/model/usage（325-330）。`compaction/summary` 事件按此记录（`compaction.md:14`：带标记时必须带完整 `rawOutput`，可由日志+代码重建）。

---

## 8. 对本插件最可行的组合用法

目标链路：**创建独立 worker 会话 → 投递任务书 → 观察其提问/结束 → 向其回传用户回答**。

1. **创建**：`inject: ['sessionController', 'sessionQuery', 'agents', 'workspaceRegistry']`；
   `const { sessionId } = await ctx.sessionController.create({ workspaceId（或 cwd）, agentPreset? }, signal)`。
   要出现在指定 workspace 侧栏就传 `workspaceId`；只传 `cwd` 的会话重启后按路径自动归组（§1.2）。标题随后 `ctx.sessionController.rename({sessionId, title}, signal)`。
2. **投递任务书**：
   `await ctx.sessionController.prompt({ requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{type:'text', text: 任务书}] }, AbortSignal.timeout(…))`。
   - 必须带 `signal`；`requestId` 自己造且可安全重试（幂等）；
   - `mode:'queue'`（排到下一轮）或 `'steer'`（运行中插最近 step）；空闲即唤醒开轮（§2.3）。
3. **观察运行状态**：
   - 事件：`ctx.on('api-session/status', (id, running) => …)`（全局 emit，最简）；需要细粒度用 `ctx.on('agent/status', ({agent, status}) => …)`（scope 无关，全局监听全收）；
   - 轮询/等待：`ctx.sessionController.state({sessionId}, signal)`（`running`/`queue`/`pendingInput`）或 `ctx.sessionController.wait({sessionId, timeoutMs}, signal)`（`reason: 'idle'|'input-required'|'timeout'` —— 直接给出「结束/等输入」判定）；
   - 需要读历史：`ctx.sessionQuery.observeSession(sessionId)`（记得 dispose）或 `readSession/listEvents`。
4. **接住它的提问**：
   `ctx.on('user-questions/request', async (request, next) => { if (request.agent?.session.id !== workerId) return next(); …自己的转发/等待逻辑；return {answers} })`。
   - 全局监听即收所有会话；用 `request.agent` 区分来源；
   - 返回答案 = 认领（客户端不再弹卡片）；`next()` = 放行给客户端 UI；
   - 若要抢先于客户端兜底 UI：注册时 `{ prepend: true }`，或接受默认顺序（客户端先拿到，客户端不答才轮到你）；
   - 已 continued 的迟到回答：`ctx.userQuestions.answer(agent, callId, {answers})`。
5. **回传用户回答**：优先瀑布认领（答案直接回到工具结果）；错过窗口则 `answer()`；或干脆 `sessionController.prompt` 一条新消息把答案写进去（会成为普通用户轮次）。
6. **结束与收尾**：等 `api-session/status (id, false)` / `wait()` 返回 idle 后，可用 `ctx.sessionQuery.readTitle/listEvents` 汇总结果；历史超长时可 `ctx.compaction.compactNow(agent, signal)`（要求拿到目标会话的存活 idle agent，`ctx.agents.get(sessionId)`）。

---

## 9. NOT FOUND / 未竟事项

- **`ctx.sessions` 创建类 API**：`ctx.sessions`（`dsh-session`，`asar:dsh-session/lib/index.js:1748`）是存储/投影面，未提供带 preset 解析的 create；创建统一走 sessionController（或底层 `ctx.agents.create` + agent-loop 工厂，不推荐）。已搜：dsh-session 全包、dsh-agent 全包。
- **workspace-controller 的 `addSession`/`upsert` 命令**：NOT FOUND（不存在此名命令）。已搜：`dsh-api-workspace-controller/lib/typert.host.js` 全部 14 个命令（§5 列表）、README。等效能力 = `session/create` 内部 `workspace.attachSession` + `workspace/insertSessionBefore`。
- **`session/create` 带 `title` 参数**：NOT FOUND。标题只能事后 `session/rename` 或自动标题。
- **SubagentRuntime 上名为 `prompt` 的通用跨会话方法**：`subagents/prompt` 存在但语义限定「经精确存活直父投给 continuable 子」（§2.4）；不存在面向任意会话的 subagent 投递。
- 浏览器侧 New Session 按钮到 `session.create` 的逐帧调用链未逐行追（client.js 是压缩产物），但命令身份由侧栏权限门控 + README 明文双重确认。
