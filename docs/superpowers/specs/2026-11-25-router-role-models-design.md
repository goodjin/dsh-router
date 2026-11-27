# 角色候选模型：派发子会话按角色换模型并继续

日期：2026-11-25。状态：设计，D11 已由用户定下，可直接拆实现。本文只约束 `dsh-router`。不写生产代码的说明：实现时才改 `src/` 与测试；本文件不授权改 `dsh-model-fallback` 或其他插件。

宿主契约以离线镜像 `dsh-plugins/docs/official/`（`dsh-v0.2.2-rc.1`）为准。与桌面版不一致处两处都写，并写明按哪一个落。桌面版只读：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（单文件，不是目录）。asar 没有稳定行号，下面用类名与函数名指认。

## 范围与非范围

| 决定 | 本方案做什么 | 明确不做 |
| --- | --- | --- |
| D1 | 每个角色一份有序候选 `{provider, model}[]`，挂在角色模板上（保存顺序是轮转的基准顺序） | 不建「模型」实体，不做跨角色共享名单 |
| D2 | 子会话某一轮结束后：记下失败、`agent.model.select` 换到下一个、再投递一条固定「继续」。报告里另写一条切换记录 | 不在同一步里换模型重试；不返回 `{kind:'retry'}`；不走 `agent/request` 替换配置 |
| D3 | 候选写在角色 md；协作页可从已注册清单选，也可手工改。（`router_dispatch` 的临时指定已退役：派发不接受 `provider`/`model`） | 临时指定不写回角色文件；下次新派发不沿用 |
| D4 | 只给派出去的子会话传模型、只对那些子会话切换 | 不改 Router 主会话自己的模型；不调用会写部署默认模型的 `session.selectModel` |
| D5 | 分类与切换都在本插件内用稳定字段自己写 | 不改、不装、不 import `dsh-model-fallback` |
| D6 | 没配候选：派发对象不出现 `agentOptions`，不登记游标，不做自动切换 | 不拒绝这种派发，不替它填主会话模型 |
| D7 | 通道故障（额度、限流、超时断网、服务端）等宿主重试放弃、轮次结束后再切；适配器未注册（`NO_ADAPTER`）在第一次 `turn/end` 后切。`INVALID_REQUEST` 只按 D11 切 | 内容被拒、参数错误、用户中断不切。不得把整个 `INVALID_REQUEST` 无条件当成切换条件 |
| D8 | 同一次子会话的游标只前进。用通的候选一直用到它自己再失败。已经失败的候选这次不再试。下一次新派发重新随机取一个起点，按轮转顺序走（起点随机 + 到头绕回） | 不在同一次子会话里回头试首选；不做跨角色冷却 |
| D9 | 可切换失败把序列走完：停下。任务 `workLabel` 改为 `受阻`。报告写试过谁、最后一次错误，并写明没有退回主会话模型 | 不空转、不再投递继续、不用主会话模型再试一次 |
| D10 | `routerCollaboration` 仍 `provide` 在根作用域；`apply` 返回的注销函数调用 `provide` 交回的释放函数，把这条登记卸掉 | 不把服务挪出根作用域；不重做隔离实验（现码仍是根发布 + 空注销器，上次结论成立） |
| D11 | `code === 'INVALID_REQUEST'` 时，当场读该 provider 已注册的 `listModels`。读成功且失败的 model id 不在其中：当成模型不存在，前进到下一个候选 | 读成功且 id 在清单里：当成参数错误，不切、不标受阻、不写切换报告。清单读不到（没有 `llm`、`listModels` 抛错、或该 provider 不在已注册列表里）：不靠这条，同样不切 |

由上述决定直接推出、实现必须照做的规则：

- 一次派发的候选序列 = 该角色已保存的候选，按 `provider` 与 `model` 的精确字符串去重（先出现的保留），再**随机取一个起点旋转成轮转顺序**（起点 k → `[k, k+1, …, 末尾, 1, …, k-1]`）。序列的第一项就是子会话初始模型，失败后继续往后走，走完一圈即穷尽。序列不写回模板，也不写回角色文件。
  - 随机源可注入（派发依赖里的 `random?: () => number`，缺席用 `Math.random`），只为让测试能钉死起点。
  - 候选只有一个时序列不变；角色没配候选时不传 `agentOptions`（D6 不变）。
- 保存时拒绝形状不合法的条目（缺 `provider` 或 `model`，或不是 trim 后的非空字符串，或带多余键）。形状合法但宿主当前没有的模型，保存放行；运行时若表现为 `NO_ADAPTER` 则按 D7 换下一个。不在 `listModels` 里不等于「不存在」。
- 不设计 `reasoningEffort`。不设计 `maxTokens` 覆盖。不改主会话模型。

D11 的判定细节（用户 2026-11-25 原话：「只在这个 id 当时不在清单里时才换。」）：

- 「当时」是处理这一次 `turn/end` 的时刻，当场重读，不用派发时的旧快照。
- 只查失败候选自己的 `provider`，用 `listModels(provider)` 的 `id` 做精确字符串比较（与保存时 trim 后的 `model` 比，不比显示名，不跨 provider 搜）。
- `listModels` 成功且返回的列表里没有这个 id（包括成功但列表为空）：切换。
- `listModels` 成功且有这个 id：不切换。
- 读不到清单：不切换。读不到包括没有注入 `llm`、`listProviders` / `listModels` 抛错、已注册列表里没有这个 provider。不要把空列表和抛错混成一类。
- 这条只适用于 `INVALID_REQUEST`。`NO_ADAPTER`、额度、限流、超时断网、服务端仍按 D7，不看清单。`HTTP_*`、`AUTH`、`EMPTY_RESPONSE` 等排除码仍不切。
- 保存时仍然放行「形状合法但清单里没有」的 id。D11 不是保存校验。
- 已知后果：内容被拒如果也被收成 `INVALID_REQUEST`，且这个 id 当时不在清单里，会换下一个。id 在清单里则不换。用户接受这个区分，不再单开观测门禁。


## 现状证据

### 派发没有模型参数

`src/collaboration/dispatch.ts` 的 `SubagentsFace.startActivation`（28–38 行）的 `request` 只有 `prompt`、`parent`、`maxDepth`，没有 `agentOptions`。`spawn` / `fork` 的实际调用（235–241 行）是：

```ts
{
  provider: mode,
  label: `${role.name}·${taskId}`,
  request: { prompt: [{ type: 'text', text: instruction }], parent, maxDepth: 2 },
  signal,
  delivery: 'parent',
}
```

没有 `agentOptions` 键。`continue`（177–207 行）走 `subagents.sendMessage`，并把 `[追加要求]`（`APPEND_MARKER`，65 行）拼进任务正文。继续投递不是 `startActivation`。

官方 `docs/official/reference/subsystems/subagent.md`：

- `SubagentCapabilities.agentOptions`（19 行）。
- `SubagentStartRequest.agentOptions?: AgentOptions`（94–101 行）：进程内提供方在创建子级时把它合并到父 Agent 的 options 上。合并发生在创建时，所以只有 `startActivation` 该带；`continue` 是往已有子会话投递，不该带。
- 128 行：只有 spawn 支持独立 `agentPreset`；省略和 fork 都继承父方的活跃组装。
- `startActivation` 签名（433–445 行）接受 `SubagentActivationSpec`，其 `request` 即上面的 start request。

`AgentOptions`（`docs/official/reference/subsystems/core.md` 199–208 行）含可选 `provider`、`model`、`reasoningEffort`、`maxTokens`。本方案只传 `provider` 与 `model`。

桌面版 asar 两类进程内后端都支持 `agentOptions`（与官方「能力标记为真才接受」一致，本方案按此落）：

- `SpawnInProcessProvider`：`agentOptions: true`，`agentPreset: true`，`inheritsParentContext: false`。
- `ForkInProcessProvider`：`agentOptions: true`，`agentPreset: false`，`inheritsParentContext: true`。

因此 spawn 和 fork 都可以带 `{provider, model}`。fork 仍然继承父方组装，只是路由用这份覆盖。官方 97–99 行写「合并到父 Agent 的 options」。桌面版 `parentAgentOptionsForDelegation` 更具体：若 `parent.session.requestHeader()?.config` 存在，父路由取这次请求头的 `provider` / `model` /（有则）`reasoningEffort`，否则展开 `parent.options`。`resolveChildAgentOptions` 再把请求里的 `agentOptions` 铺在上面；路由变了且请求没写 `reasoningEffort` 时删掉父级的 `reasoningEffort`，让所选模型用适配器默认。

D6 按桌面版理解：不传 `agentOptions` 时，子会话用主会话最近一次请求头上的模型（没有请求头才落到 Agent options）。这就是「主会话最近一次的模型」。实现要保持字节级：没配候选时，传给 `startActivation` 的对象不多一个 `agentOptions` 键，也不多别的键。官方散文的「父 Agent options」与桌面版「优先最近请求头」不一致；落点用桌面版，因为 D6 说的是最近一次。

`assertCapabilities`：请求带了 `agentOptions` 而该后端 `capabilities.agentOptions === false` 时抛 `UNSUPPORTED_CAPABILITY`。当前 spawn/fork 都为真。若将来某个后端为假，派发原样上抛，不在本插件里吞掉再换候选（见未知项）。

### 运行中换模型

官方 `docs/official/reference/subsystems/session.md` 869–874 行：`SessionController.selectModel`「显式恢复 Session 之后选择一个 Session 本地模型，并在后台保存默认」。返回归一化后的选择，不等待默认值落盘。

桌面版 `selectModel` 在此之上还会 `ctx.llm.resolveCallConfig(selected)`，失败抛 `RemoteError` `"session/model-unavailable"`，并 `ctx.agentDefaultModel.saveSelection(selected)`（失败只打日志）。这会改部署默认模型，波及之后新建的会话，违反 D4。子会话切换禁止调用 `selectModel`。

官方 `core.md` 的 `Agent` 接口（62–143 行）没有 `.model`。桌面版循环上的 `agent.model` 是 `AgentModel`：

- `select(selection)` 在与已记录选择不同时，只 `session.append("model/selection", …)`。不写部署默认。
- `current()` = 已记录的 `pending ?? lastUsed`，否则才是创建时的 `options`（两者都有 provider 与 model 时）。
- 持久化目录 `docs/official/reference/persistence-catalog.md` 693–700 行：`model/selection` 是 log-only，不进模型可见历史。字段（4336–4346 行）为必填 `provider`、`model`，可选 `reasoningEffort`。冷恢复按日志重放，宿主已选中的模型还在。

同一步不能换，官方与桌面版一致。`agent/request`（`core.md` 964–986 行）只能替换已经冻结的调用配置；桌面版在步骤准备已经固定路由后再改 provider/model 会抛：`agent/request proposed "…" after step preparation fixed "…"; use agent.model.select() before step preparation`。`select` 在打开的步骤里只记下 pending，下一步 `pre-step` 才生效。`dsh-model-fallback` 的做法与此相反（见替代方案），不能抄。

桌面版 `installModelSelection` 会在下一步路由与上一次请求头不同时，向用户消息注入一句英文通知，开头为 `[model changed: assistant turns above this point were generated by`。那是宿主自己的痕迹。本方案的中文继续句和报告记录另外写，不拿这句当报告。

本方案的切换接口是子会话上的 `agent.model.select({ provider, model })`，不带 `reasoningEffort`。运行时如果没有这个函数：任务标 `受阻`，报告写明宿主没有 `agent.model.select`。禁止改用 `selectModel`。

### 失败信号与「宿主已经放弃」

要用的稳定面：

- `session/event`（`session.md` 1299–1314 行）：提交后的追加。`turn/end` 的 `reason` 是 `TurnEndReason`（`session.md` 700–728 行）。`kind: 'error'` 的 `error` 是 `LlmFailure`。
- `LlmFailure`（`llm-streaming.md` 232–252 行）：稳定字段 `message`、`code`、可选 `status`、`providerRetryAfterMs`、`requestId`。判定只用 `code` 与 `status`。不读 `message` 做分类（`dsh-model-fallback` 的正则只作语义对照，不复制）。
- `agent/status`（`core.md` 1022–1038 行）：`idle` | `running`。`running` 不能证明某一轮还开着；`idle` 表示没有驱动器还排着或在跑。
- `agent/request-error`（`core.md` 336–340 行与 993–1015 行）：每次失败尝试、在重试或关闭步骤之前。listener 返回 `{kind:'retry'}` 且不调用 `next()` 表示自己接手；默认 `undefined` 让失败保持终态。官方目录写明：这个事件在「循环重试或关闭步骤之前」。

时序（`docs/official/reference/agent-lifecycle.md` 46–80 行）：请求失败 → `agent/request-error` → 要么在仍打开的步骤里重试，要么最终 `turn/end`，然后 `agent/status` idle。`develop/framework/events.md` 104 行：`turn/end` 不是同名 Cordis 事件，要听 `session/event` 再看 `event.type`。

桌面版 `dsh-llm-retry` 的 `recover`：

- 策略缺失则 `next()`。
- `mode === 'always'` 时按该策略继续重试（无有限次数）。
- 否则 `failure.code` 不在 `policy.retryableCodes` 里则立刻 `next()`。
- `mode === 'normal'` 且已达 `maxRetries` 则 `next()`。
- 要重试时先追加 `llm/retry`，延迟后再追加 `llm/retry-started`，然后返回 `{kind:'retry'}`。

默认码（桌面版 `DEFAULT_RETRYABLE_CODES`）：`EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`。`DEFAULT_MAX_RETRIES = 5`。官方 `config-catalog.md` 1883 行只写「省略则 normal、重试五次」，没有列出这五个码。码表按桌面版落，并在文档里保持这个差异说明。

因此「宿主已经放弃」的判据是：我们跟踪的子会话出现 `session/event`，`event.type === 'turn/end'` 且 `reason.kind === 'error'`。此前的 `agent/request-error` 与 `llm/retry` 都还在重试窗口里。本插件不订阅 `agent/request-error`，不返回 `{kind:'retry'}`，不在那个监听器里 `select`。

`kind: 'aborted'` 是取消（用户、父级、钩子、释放），不切换。`completed` / `max-tokens` / `blocked` / `interrupted` / `forked` 都不是通道故障，不切换。

### 适配器不存在长什么样

官方文档全文没有 `NO_ADAPTER` 这个标识符。`AgentOptions.provider` 的注释只说调用时必须有已注册适配器（`core.md` 201 行）。`llm-streaming.md` 533 行：`LlmModelInfo`「目录成员身份是建议，不是请求校验」。831 行附近同样写明目录不是请求白名单，适配器可以接受未列出的模型 id。没有 `UNKNOWN_MODEL` / `MODEL_NOT_FOUND`。

桌面版：

- `LlmRuntime.registration`：没有登记则 `throw new LlmError('no adapter registered for provider "…"', 'NO_ADAPTER')`。
- 循环里 `prepareCall` 只吞 `NO_ADAPTER`，仍用 `proposedConfig` 继续；随后的流再失败。`NO_ADAPTER` 不在默认重试码里，所以第一次尝试后 `recover` 走 `next()`，轮次结束。这就是可实现的「第一步就换」：仍等 `turn/end`，不在 `prepareCall` 被吞的那一步里切（那一步还没结束，切了违反 D2）。
- 默认适配器的模型解析不因为目录里没有这个 id 而失败。DeepSeek `providerError` 把 HTTP 400 / 413 / `invalid_request_error` 收成 `INVALID_REQUEST`。一个不存在的 model id 经常走这条，和「参数错误」同一稳定码。区分办法是 D11，不是另找一个错误码。

桌面版额度码：`QUOTA_EXCEEDED_CODE = "QUOTA"`，`ACCOUNT_QUOTA_EXCEEDED_CODE = "ACCOUNT_QUOTA"`。两者都不在默认重试码里，宿主第一次就放弃；我们仍然等 `turn/end` 再切，避免和自定义重试策略赛跑。

桌面版 `classifyPiAiError`（pi-ai 路径）把 400 / invalid request / 413 收成 `INVALID_REQUEST`，401/403 收成 `AUTH`，429 收成 `RATE_LIMIT`，5xx 收成 `SERVER`，超时 `TIMEOUT`，网络 `TRANSPORT`，其余 `PI_AI_ERROR`。DeepSeek `providerError`：401/403 或 `authentication_error` / `permission_error` → `AUTH`；额度或 402 → `QUOTA`；429 或 `rate_limit_error` → `RATE_LIMIT`；上下文窗口 → `CONTEXT_WINDOW_EXCEEDED`；400/413 或 `invalid_request_error` → `INVALID_REQUEST`；5xx 或 `api_error` / `overloaded_error` → `SERVER`；没有 status → `SERVER`；其他 status → `` `HTTP_${status}` ``。没有单独的内容审查码。

### 协作页清单从哪读

浏览器到不了 `ctx.llm`。现有页面只打 HTTP `/router/collaboration/*`（`src/collaboration/routes.ts` 30 行 `COLLABORATION_ROLES_PATH`）。

协作页清单用 `ctx.sessionController.modelCatalog()`（Host generation 目录，与聊天输入框的模型选择器同一份；`sessionController` 是可选能力，机会式注入）。取返回的 `groups`（可路由提供方分组，每项 `id`/`name`/`models` 的 `id`/`name`），`failures` 里的提供方不进清单。不用 `llm.listProviders`/`listModels` 全量枚举，也不用 `listConfigurableProviders`。

反转（2026-11-26）：本设计稿原稿选 `llm.listProviders`/`listModels`（「当前已注册」口径）而不用 `modelCatalog`。用户在界面上看到「聊天输入框里被屏蔽的模型也出现在角色候选面板」，要求两边一致；调研确认聊天输入框的模型选择器消费的就是宿主的 `modelCatalog()`（`buildModelCatalog` 的产物：只用已激活提供方、逐模型校验、空组丢弃、出错进 failures）——即原稿标注「不用」的那份 Host generation 目录。据此 /router/collaboration/models 改走 `sessionController.modelCatalog()` 的 `groups`，failures 不进清单；拿不到目录时返回 unavailable:true，绝不退回 llm 全量枚举。不要按旧稿再改回 llm 枚举。

读不到时手工填写仍然可用，见协作页一节。

### 角色模板现状

`src/collaboration/types.ts` 65–68 行：`RoleTemplate` 只有 `name` 与 `description`。`RoleStore.save`（79–82 行）入参同样只有这两项。文件头 7 行和 64 行的注释仍写 json / 「正文 = 职责说明」，实现已经是 md；改存储时把注释改到与行为一致。

`src/collaboration/roles.ts`：`ROLE_EXT = '.md'`（25 行）。`readRoleFile`（103–115 行）把整个文件当 `description`。`save`（144–154 行）把 `description` 整段写入。一个角色一个文件，文件名 = 角色名。

`seedPresetRoles`（235–257 行）用整段 `description` 对 `PRESET_ROLE_TEMPLATES` 和 `HISTORICAL_PRESET_DESCRIPTIONS` 做精确相等：缺则新建，等于历史文本则升级，用户改过的永远不动。退役角色（如「主管」）只在精确命中历史文本时删除。预置模板只有职责，没有候选。本方案不给预置角色发明候选。

职责消费：

- `composeDispatchInstruction`（`dispatch.ts` 68–89 行）把整段 `description` trim 后注入初始指令。
  （现状更正 2026-11-26：初始指令不再注入职责正文；职责改由上下文行按会话注入子会话的系统提示词。）
- `renderRoles` / `dutySummary`（`context.ts` 104–126 行）上下文只注入第一个非空行，不注入全文。

候选文本若混进 `description`，会同时污染初始指令和上下文摘要。必须在解析结果里分开。

`src/collaboration/tools.ts` 的 `ROLE_TEMPLATE_SCHEMA`（122–130 行）`additionalProperties: false`，只有 `name` 和 `description`。`router_role_save`（334–360 行）同样。不改 schema 的话，模型无法提交候选，多出来的字段会被拒绝。

`routes.ts` POST `/roles`（221–246 行）只读 `name` 与 `description`。

### 协作页

`src/client/roles-tab.tsx`：左侧列表预览 `description.slice(0, 40)`（150–152 行），右侧名称和职责文本框（172–186 行），保存按钮把 `{name, description}` 交给 `saveRole`（194 行）。`saveError` 用 alert 显示（215–218 行），`rolesError` 另有重试（207–213 行）。没有候选区。

`src/client/collaboration-api.ts` `saveRole`（120–131 行）POST 的 JSON 只有 `name` 与 `description`。`collaboration-store.ts` `saveRole`（266–278 行）失败时把 `saveError` 设上并返回 false，不把草稿清掉。

浏览器半边的三步交付是实现阶段的验收，现在不跑。条文在 `dsh-plugins/AGENTS.md` 308–317 行。不要主动退出桌面版（同文件 413–417 行）。

### 重挂

`src/entry.ts` 76–78 行：有 `ctx.root.provide` 就绑到根上发布 `routerCollaboration`。95 行 `return () => {}`，把 `provide` 交回的释放函数丢了。

官方 `docs/official/reference/cordis-api/context.md` 286–312 行：`ctx.provide` 的服务归当前 fiber；返回的释放函数或该 fiber 卸载时取消注册；同作用域重复提供会抛。根上发布的服务归根 fiber。插件入口卸载不会卸载根 fiber，所以空注销器留下登记。同进程再挂就会再报服务已在 `<root>` 注册。

`tests/collaboration/host-entry.spec.ts` 125–144 行只断言 `provide` 被叫过、返回值是函数，不调用它，也不第二次 `apply`。现有假 `provide` 返回 `() => {}` 的测试在「真正调用释放函数」之后仍然要通过。

上次对照实验的结论（保留根发布，释放挂到条目自己的生命周期）与这段现码一致。本方案不重做实验。

### 任务与标签

`WorkLabel`（`types.ts` 14 行）已含 `受阻`。不新增标签。任务记录的 `id === taskId`（`records.ts` 294–295 行创建时如此，205 行读取时核对）。D9 改的是这条任务记录的 `workLabel`。派发新建任务时标签是 `待处理`（`dispatch.ts` 222–227 行）。活跃视图把「已报告」以外的任务当活跃（`active-tasks.ts` 10 行、34–49 行），所以 `受阻` 会留在上下文里。报告是 `kind: 'report'`，不会变成活跃任务。

## 数据

### 存在哪

候选只存在角色 md 的文末围栏里，逻辑上挂在 `RoleTemplate` 上。进程内不另存一份角色候选。游标不是角色数据，见后文，不进这个文件。

```ts
interface RoleModelCandidate {
  provider: string
  model: string
}

interface RoleTemplate {
  name: string
  description: string
  /** 缺省 = 文件里没有合法围栏（D6）。不持久化空数组。 */
  models?: RoleModelCandidate[]
}
```

### md 格式

无候选时，文件字节 = 职责正文，与今天相同，不写围栏。

有候选时，在职责正文后接围栏。正文不以 `\n` 结尾就先补一个换行，再写标记。标记独占一行，中间每行一个 JSON 对象，顺序即优先级：

```markdown
<职责正文，原样>
<!-- dsh-router:models -->
{"provider":"deepseek","model":"deepseek-chat"}
{"provider":"openai","model":"gpt-4.1"}
<!-- /dsh-router:models -->
```

读：

- 没有单独成行的 `<!-- dsh-router:models -->`：`models` 缺省，`description` = 文件精确字节。
- 有开始标记：`description` = 该行之前的精确切片（含它前面的换行）。围栏和 provider 字符串都不进入 `description`。
- 开始与结束必须成对；中间每一行必须是 JSON 对象，且恰好有 `provider`、`model` 两个键，值都是 trim 后非空的字符串。存盘值用 trim 后的结果。
- 围栏损坏（缺结束、半行 JSON、缺字段、空字符串、多余键、非对象）：抛 `CollaborationError('INVALID_INPUT', …)`，消息带角色名。不要当成「没配候选」（那会悄悄变成 D6），也不要把坏围栏并进职责正文。`list()` 今天一个文件读失败就整份失败，保持这个形状；协作页走现有 `rolesError`。

往返：读出来的 `description` 再按同一规则写回，围栏稳定。有候选时，职责与标记之间那一个分隔换行算在读回的 `description` 里（原文已以换行结尾则不另加）。`composeDispatchInstruction` 会 trim，`dutySummary` 按非空行取，分隔换行不改变注入文本和摘要。

`<!-- dsh-router:models -->` 这行变成保留行。职责正文里若出现这一精确行，按围栏解析；解析失败即 `INVALID_INPUT`。

### 与职责分离

`roles.read` / `list` 返回的 `description` 只是围栏前的切片。`composeDispatchInstruction`、`renderRoles`、`dutySummary` 只吃这个字段，不读文件原文，也不在 `context.ts` 再写一套剥离。初始指令和上下文摘要里不出现标记、provider 或 model。

### 旧文件

没有围栏的旧 md：行为与字节和现在一样。`seedPresetRoles` 的相等比较只对「没有围栏」的文件用整段 `description`（此时它就是文件字节）。现有「历史文本精确升级」测试保持有效。

有围栏的文件视为用户改过这份角色文件：不升级职责，不因职责正文碰巧等于历史预置而覆盖，也不因退役表命中而删除。否则「只加了候选、职责还是预置原文」会被种入逻辑写回成无候选的新职责。这是现有精确匹配规则在「文件被用户改过」上的应用，不是新的覆盖策略。升级一条没有围栏的历史预置时，`save` 只写新职责，不写围栏。

预置角色种入仍然只写 `preset-roles.ts` 里的职责。不给预置角色填候选。

### 保存校验

`RoleStore.save`、POST `/roles`、`router_role_save` 共用同一校验（放在 `src/collaboration/role-models.ts`，三者调用它）：

- `models` 缺省：保留该角色盘上已有的候选。这样今天的调用方只改职责时不会把候选抹掉。新角色没有旧文件，结果就是无候选。
- `models: []`：明确清空，文件只写职责，不留围栏。
- `models` 为数组：逐条校验。`provider`、`model` 必须是字符串，trim 后非空，存 trim 后的值。多余键、非对象、非数组，整次保存拒绝，不写文件。
- 不因为宿主当前 `listModels` 里没有这个 id 而拒绝。
- 保存顺序是**轮转的基准顺序**，不是严格优先级：派发时起点随机，起点之前的那些候选会被排到序列末尾。存储时不去重；派发序列才去重。
- 校验失败码用现有 `INVALID_INPUT`。不新增错误码。

工具 schema 与 POST 体都允许可选 `models`。`additionalProperties` 仍为 false。

## 派发

### 临时指定落在哪个字段

> 已退役：派发工具不再接受 `provider` / `model`（出现即 `INVALID_INPUT`）。下面的写法是当初的设计记录，现行口径见「序列」。

`router_dispatch` 增加两个可选参数，仅 `spawn` / `fork`：

- `provider`：字符串
- `model`：字符串

两个都缺：没有临时指定。两个都在：这一次的首选，不写回角色文件。只出现一个，或 trim 后为空：`INVALID_INPUT`，在读角色和建任务之前拒绝。`continue` 上出现任一字段：`INVALID_INPUT`，不投递、不改任务正文。

不使用嵌套对象，避免和 `AgentOptions` 的字段名再分一套。不接受 `reasoningEffort`。

### 序列

`resolveDispatchSequence(role.models, random)`：

1. 放角色候选（没有则为空）。
2. 按 `provider + '\0' + model` 精确去重，保留先出现的。
3. **随机取起点并旋转**：起点 `k = floor(random() * n)`（夹在 `[0, n-1]`），序列变成 `[k, k+1, …, 末尾, 1, …, k-1]`。随机源缺席用 `Math.random`；随机源给出坏值（NaN、越界、抛错）时退回 `k = 0`，不让派发因随机源坏了而失败。

   - 轮转后的第一项 = 子会话初始模型；失败回退沿这条序列往后走，于是「到头就从头」天然成立——起点之前的那几项正排在序列末尾。
   - 一个候选时没有可轮转的余地，序列不变。

临时指定（`override`）已随「派发工具去掉指定模型的能力」退役：派发出现 `provider` / `model` 一律 `INVALID_INPUT`。模型完全由角色自己的候选决定。

序列为空：不登记游标。`startActivation` 的参数对象与今天 235–241 行相同，键集合不含 `agentOptions`。返回值键也不变：成功是 `childId`、`taskId`、`createdTask`、`record`；登记失败是 `childId`、`taskId`、`createdTask`、`recordError`（253–261 行）。

序列非空：

- `request.agentOptions = { provider: sequence[0].provider, model: sequence[0].model }`，只有这两个键。
- 子会话创建成功后，在本次 `apply` 挂上的游标表里记下这条子会话（见状态机）。创建抛错则不登记，错误原样上抛，不在 `startActivation` 外面替剩下的候选再循环创建。
- 成功返回和 `recordError` 返回都可以多一个 `model: { provider, model }`，值为实际传出的第一个候选。没配候选时不要这个键。

`continue` 不重置游标，不传 `agentOptions`。对一个没有游标的旧子会话做 `continue`，不会因此开始自动切换。

职责注入仍用解析后的 `description`（现状更正 2026-11-26：注入位置从初始指令改为子会话的系统提示词）。分工记录的 `body` 仍是 `composeDispatchInstruction` 的结果，不写入候选 JSON。

## 一次子会话的状态机

游标（仅进程内，挂在当次 `apply` 创建的 face 上，不挂模块全局，以免卸载后还活着）：

```ts
interface ChildModelRun {
  sequence: readonly { provider: string; model: string }[]
  /** 当前正在用的下标。只增不减。 */
  index: number
  phase: 'armed' | 'switching'
  rootSessionId: string
  taskId: string
  roleName: string
  /** 派发时 exec.agent 的 id。投递时再按 id 取在线实例。 */
  parentSessionId: string
  /** switching 时，触发这次前进的那一轮的 turn 号。 */
  failedTurn?: number
}
```

键是子会话 id。只为「本次进程里、带着非空序列派发出去」的子会话建条目。不扫描历史分工来重建。

监听放在插件入口的 `ctx.on`，不放进预设里的 agent 作用域。`session/event` 对 agent 作用域的监听者只投递「经该 agent 上下文进入的会话」（`session.md` 1301–1309 行）。入口 fiber 不是 agent，才能看见子会话。回调用 childId 过滤，主会话和其他会话忽略。

`session/event` 的监听异常会被宿主记下并吞掉（同节：observer failures contained）。监听器里的异步必须自带 `catch`，未捕获的 rejection 会让宿主退出（`AGENTS.md` 138–157 行）。监听用的 `AbortSignal` 是入口级 `AbortController`，在 `apply` 的注销函数里 abort。不用派发工具那次的 `exec.signal`（子会话失败时那次调用早已结束）。

### 何种失败前进一步

只在 `phase === 'armed'` 且事件是该子会话的 `turn/end` 时评估。`reason.kind !== 'error'`：不切换，下标不动，phase 保持 `armed`（这一轮的中断或完成不永久拆掉机器；之后另一轮若是可切换失败，仍可前进）。

`kind === 'error'` 时读 `error.code` 与 `error.status`：

可切换（前进）：

- `code === 'NO_ADAPTER'`：适配器未注册。宿主默认不重试，第一次 `turn/end` 就到。这是本方案落地的「第一步就换」。
- `code` 为 `QUOTA` 或 `ACCOUNT_QUOTA`：额度。
- `code === 'RATE_LIMIT'`：限流。
- `code` 为 `TIMEOUT` 或 `TRANSPORT`：超时断网。
- `code === 'SERVER'`：服务端。
- 以上都不中，但 `status === 429`，且 `code` 不在下面的排除表：按限流。
- 以上都不中，但 `status` 是 500–599，且 `code` 不在排除表：按服务端。

排除表（命中则这一轮不前进，即使 status 是 429 或 5xx）：`AUTH`、`INVALID_CREDENTIAL`、`MISSING_CREDENTIAL`、`CONTEXT_WINDOW_EXCEEDED`、`EMPTY_RESPONSE`、`PI_AI_ERROR`、`UNKNOWN`、`IMAGE_OFFLOAD_REQUIRED`、`STREAM_CLOSED`、`MALFORMED_RESPONSE`，以及以 `HTTP_` 开头的码。`INVALID_REQUEST` 不进这张表，单独按 D11。

`INVALID_REQUEST`（D11）：当场 `listModels(失败候选.provider)`。读成功且 id 不在列表中则前进；读成功且 id 在列表中，或清单读不到，则不前进、不标受阻、不写切换报告。比较只用模型 `id`。

其余未识别的 `code`：不切换。内容被拒若以 `turn/end` `completed` 出现，自然不切。内容被拒若被收成 `INVALID_REQUEST`，跟 D11 走：id 不在当时清单里才切。

`EMPTY_RESPONSE` 在桌面版默认重试码里，但 D7 的通道故障不含「空回复」，所以重试放弃后也不切。`CONTEXT_WINDOW_EXCEEDED` 交给宿主压缩，不切。`AUTH` 不是额度。

自定义 `retryableCodes` 若包含 `QUOTA` 或 `NO_ADAPTER`，宿主会多试几次；我们仍只看最终 `turn/end`，不自己数次数。`mode: 'always'` 时这一轮可能永远不结束，我们也不去打断。这是宿主策略，不是本插件的超时。

### 换模型与继续

判定要前进时，同步把 `phase` 改成 `switching` 并记下 `failedTurn`，然后再 await。同一子会话上重叠的事件不得再进入一次切换。

然后等这个子会话 `idle`：

- 若此时 `agents.get(childId)?.status === 'idle'`，立刻进入选择。
- 否则等下一次 `agent/status` 且 `status === 'idle'` 且 `agent.id === childId`。等到时再读一次 `status`，仍是 `idle` 才继续。
- 在此之前若看到该子会话新的 `turn/start`（轮号大于 `failedTurn`）：放弃这一次切换，`phase` 回到 `armed`，下标不动。那一轮若成功，说明当前候选还能用；若又是可切换失败，按新的 `turn/end` 再评估。不往 `running` 的轮次里投递（`tool-catalog.md` 2174–2176 行：运行中的目标会 steer 最近一步；idle 才开新轮）。
- 不发明超时。idle 一直不来就保持 `switching`，不标 `受阻`，不投递。条目卸载则整张表消失。

选择与投递（仍在 `switching`，且没有更新的 `turn/start`）：

1. `agents.get(childId)`。没有在线 agent：不调用 `sendMessage`（官方 `subagent.md` 456–459 行：不在场的直接子级会冷恢复；我们还没 `select`，不能让新轮次在旧路由上开）。写受阻报告。不自己 `agents.resume`。
2. `agent.model.select` 不是函数：受阻。不用 `selectModel`。
3. 从 `index + 1` 起向后找。对每个剩余候选调用一次 `select({ provider, model })`。第一次没抛的就停在它上面。全部抛错：受阻，不投递。这不是模型重试，也不是回头。桌面版 `select` 通常只追加日志、不校验目录，所以抛错是异常路径。
4. `select` 成功后取父级：`agents.get(parentSessionId)`。没有在线父级：受阻。模型已经改到新候选，报告里写明「已改模型，未能取得在线父会话，未投递」。不 `resume` 父级（那会碰主会话，违反 D4）。
5. `subagents.sendMessage(parent, childId, [{ type: 'text', text }], { signal })`。`text` 固定为下面这一句，句号用中文：

   `已从 ${fromProvider}/${fromModel} 换到 ${toProvider}/${toModel}，继续原任务。`

   `from` 是失败的那个候选（原 `index`），`to` 是 `select` 成功的那个。这句话里不附错误码、不附候选清单。`signal` 用入口的生命周期信号。
6. 投递成功：`index` 改为 `to` 的下标，`phase = 'armed'`。另写一条切换报告。之后留在这个候选上，直到它自己再出现可切换失败。
7. 投递抛错：下标改到已经 `select` 成功的那个（模型已经换过去了），`phase` 留在终止处理里不再自动试下一个，任务标 `受阻`。不紧循环重投。

内部再投递是直接 `sendMessage`。不要走 `router_dispatch` 的 `continue`：那条路径会把 `[追加要求]` 写进任务正文（`dispatch.ts` 190–198 行），和「报告里注明切过」不是一回事。

没有下一个候选：不 `select`，不投递。任务标 `受阻`。写穷尽报告。`phase` 不再回到 `armed`（把条目留在表里但不再处理该 childId 的后续 `turn/end`，避免穷尽之后又写一遍）。

### 受阻与报告

「对应任务」= `kind: 'task'` 且 `id === taskId` 的那条。`records.update(rootSessionId, taskId, taskId, { workLabel: '受阻' })`。然后 `activeTasks.refresh(rootSessionId)`，失败只 `console.warn`。

报告用现有 `records.create`，`kind: 'report'`，`workLabel: '已报告'`，`taskId` 指向该任务，`sessions: [{ sessionId: childId, label: roleName }]`。不新增标签。

切换成功的报告正文写：从谁换到谁、`code`、有则写 `status`、`message`、本次序列、已经放弃的前缀，并写明未退回主会话模型。子会话里的继续句不承担这段。

穷尽报告正文写：试过的每个 `provider/model`、各自的 `code` / `status` / `message`、最后一次错误、已停止、未退回主会话模型、未再投递继续、任务已标为受阻等待用户决定。

选择或投递失败的报告写明卡在哪一个候选、`select` 是否已经改了模型、投递是否发生、最后一次错误。同样把任务标 `受阻`。这是「不能安全地再自动走下一步」，对应 D9 的停下，避免空转。

不可切换的终态错误：不 `select`，不投递，不改任务标签，不新写报告。宿主原有的结束通知照常到父会话。

写报告或改标签失败：记下 warn，不向宿主抛。不重试循环。

## 游标放哪

只放进程内存：`RouterCollaborationFace` 上的 `Map<childSessionId, ChildModelRun>`，在 `apply` 里 `new Map()`。工具行和监听器拿的是同一个 face（根服务），所以共用这一张表。不要模块级 `Map`。不要新文件、新表、新数据库。不要定时器。

桌面版重启，或本插件卸载后重挂：这张表是空的。

- 不调用 `select`，不把正在跑的子会话拨回列表第一个。宿主日志里的 `model/selection` 还在，冷恢复后 `current()` 仍是重启前选中的候选（除非别的代码再 `select`；本插件不这样做）。
- 不根据角色文件重建游标。临时指定和「哪些已经失败」都没落盘，重建会把已失败候选再试一遍，违反 D8。
- 因此这条已经存在的子会话，后续失败不再自动换、不再自动标 `受阻`、不再另写切换报告。宿主原有结束通知仍到父会话。用户要再换，就重新派发一次。新的 spawn/fork 重新随机取一个起点，按轮转顺序走（起点随机 + 到头绕回）。
- 卸载时 abort 监听，并释放根服务（D10）。表随 face 丢掉。

`router_dispatch` `continue` 不恢复、不重置已丢失的游标。

## 协作页

角色编辑区在职责说明下面加「候选模型」小节，保持现有左列表 + 右编辑的结构。

- 列表仍显示角色名和职责前 40 字。预览只用 `description`，不拼接 provider。
- 右侧有序行：每行 `provider`、`model` 两个文本框，加上移、下移、删除。不设计拖拽。
- 「从清单添加」：两个下拉，数据来自新的 `GET /router/collaboration/models`。选中后追加一行，用户仍可改文本。
- 手工填写始终可用：清单为空、请求失败、或 `unavailable: true` 时，下拉可以是空的，文本框照常保存。
- 保存时 POST `{ name, description, models }`。`models` 为当前编辑的数组；用户删光则送 `[]`（服务端清空围栏）。不要在加载失败时送 `[]`，否则会误清。`rolesError` 时不把坏角色再保存一遍。
- 服务端 400 / `INVALID_INPUT` 走现有 `saveError` alert（`roles-tab.tsx` 215–218 行）。`collaboration-store.ts` 266–278 行已经在失败时保留草稿，保持这个行为。
- 左侧不单独做候选摘要；候选只在右侧编辑。避免列表把模型 id 当成职责。

`GET /router/collaboration/models` 的响应：

```ts
{
  unavailable: boolean
  providers: Array<{
    id: string
    name: string
    models: Array<{ id: string; name: string }>
  }>
}
```

装配：workbench 行对 `sessionController` 做单独的机会式 `ctx.inject?.(['sessionController'], …)`，把 `modelCatalog()` 留在闭包里。不要把 `sessionController` 加进 `webServer` 那组必需 inject（缺它时不能连累 roles/records 路由）。`webServer` 那组照常注册路由。处理函数里没拿到 `sessionController`，或 `modelCatalog()` 抛错 / 返回坏形状（无 groups）：HTTP 200，`{ providers: [], unavailable: true }`——绝不退回 llm 全量枚举。groups 里缺 id 的分组、缺 id/name 的模型条目被丢弃，不让整个角色页失败。

页面只用 `id` 与 `name`。不展示休眠路由。

### 浏览器半边验收（实现时再跑）

改了 `src/client/` 之后，按 `AGENTS.md` 308–317 行：

1. `node /Users/good/github/dsh-plugins/scripts/check-host-rows.mjs dsh-router`
2. `npm run build`（`package.json` 34–35 行：`tsc` + `tsdown`；`build:client` 就是这条。`tsdown.config.ts` 会产出 `lib/client.js`），然后 `node /Users/good/github/dsh-plugins/scripts/check-client-activation.mjs dsh-router`
3. web profile 看协作页角色区：清单可选、手工可改、坏形状在 `saveError` 里可见；无 `entry did not activate`

本方案不改 `cordis.patch.yml`。实现时若没改挂载行，不必跑 `scripts/check-subrows.mjs`。改了行就要跑（`cordis.patch.yml` 16–18 行）。需要重开桌面版时停下来告诉用户自己退出再打开，不要代劳。

## 重挂修复

最小改动在 `src/entry.ts` 的 `apply`：

```ts
const disposeService = provideRoot('routerCollaboration', face)
const watcher = new AbortController()
// 监听与 llm/agents 的机会式 inject 用 watcher.signal；inject 若返回释放函数，一并收进注销
return () => {
  watcher.abort()
  disposeService()
}
```

服务名仍是 `routerCollaboration`，仍在根作用域（76–78 行的理由不变：预设 isolate 只能看见根服务）。不要改成 `ctx.provide` 到入口 fiber。

`tests/collaboration/host-entry.spec.ts` 增加一条：假 `root.provide`（生产路径走 `ctx.root`）在同名第二次提供时抛 `service "routerCollaboration" has been registered at <root>`。第一次 `apply`，调用返回的注销函数，断言该名字已卸下；第二次 `apply` 不抛，且根上的 face 是第二次那份。不调用注销函数就第二次 `apply` 必须抛上面这句话。现有「假 provide 返回空函数、只断言 dispose 是函数」的用例保持通过。

入口 `inject` 保持 `[]`（`host-entry.spec.ts` 120–123 行）。监听与 `agents` / `subagents` / `llm` 都是机会式的，缺了就跳过自动切换或清单，派发和记录仍可用。不要为了监听把这些写成必需 inject。

## 测试清单

单元测试能锁住的：

- 无围栏文件：`description` 字节等于文件，`models` 缺省；`save` 无候选时不写出标记。
- 有围栏：职责切片不含标记和 JSON；往返稳定；trim 与多余键、缺字段、坏 JSON 在 `read` 和 `save` 都是 `INVALID_INPUT`，且失败的 `save` 不改原文件。
- 形状合法但「清单里没有」的模型可以保存。
- `models` 缺省的保存保留旧候选；`models: []` 清空且文件不再含标记。
- 有围栏的预置角色名：`seedPresetRoles` 不升级、不删除。无围栏且等于历史文本：仍升级，写出的文件没有围栏。用户改过的职责仍不覆盖。
- `renderRoles` / `composeDispatchInstruction` 的输入用解析后的 `description` 时，输出不含 `dsh-router:models` 和 provider id。
- 派发：序列空时 `startActivation` 参数深比较没有 `agentOptions`，返回键与现在相同。序列非空时 `agentOptions` 只有 `provider` 和 `model`。去重（先出现者保留）+ 随机起点旋转的顺序正确；候选数为 1 时不变；不同起点得到不同顺序但仍是同一集合的轮转；带 `provider`/`model` 一律在建任务前拒绝。`continue` 同样拒绝，且不调用 `startActivation`。
- 状态机（假的 `session/event`、`agent/status`、`agent.model.select`、`sendMessage`、`listModels`）：`agent/request-error` 不触发切换；`llm/retry` 期间不切换；`turn/end` `RATE_LIMIT` 在 idle 之后 `select` 下一个并送出固定中文句；`aborted`、`EMPTY_RESPONSE`、`HTTP_404` 不 `select`；`INVALID_REQUEST` 且 `listModels` 成功不含该 id（含成功的空列表）会前进；`INVALID_REQUEST` 且 id 在列表中不 `select`；`INVALID_REQUEST` 且 `listModels` 抛错或不存在该 provider 不 `select`、不标受阻；`NO_ADAPTER` 不看清单也会前进；下标不回头；最后一个也失败时任务 `workLabel` 为 `受阻`，报告含试过的候选和最后错误，且没有 `sendMessage`；`select` 成功但 `sendMessage` 失败时不再试下一个；没有 `agent.model` 时不调用 `selectModel`。
- 游标在 face 上：注销后再 `apply`，旧 childId 的失败不会打到新 face 的表。
- 模型路由：无 `sessionController`、`modelCatalog()` 抛错或返回无 groups 时 200 且 `unavailable: true`（绝不退回 llm 全量枚举）；有 groups 时只返回 groups 里的模型，failures 不进清单。
- 重挂测试见上一节。
- 客户端：保存请求体带 `models`；400 时 `saveError` 有文案且草稿还在。

必须等重开桌面版、单元测试替代不了的：

- 活的子会话上 `agent.model.select` 是函数，且下一步请求头变成新路由；`session.selectModel` 未被我们调用（部署默认模型不变）。
- `turn/end` 与随后的 `agent/status idle` 的真实顺序。
- 未注册 provider 是在 `startActivation` 就抛，还是创建成功后第一轮 `turn/end` 的 `code === 'NO_ADAPTER'`。
- 内容被拒、以及「已注册 provider + 不存在的 model id」的 `turn/end` `error.code` / `status` / `message`。这两项喂给「退回」和未知项，实现时不要预先把它们配进切换表。
- 三步交付的第 3 步，以及用户自己重开桌面版之后的协作页。

## 实现拆分

顺序可以按依赖微调。重挂修复与角色存储无依赖，若要先消掉同进程重载报错，可以把它提到最前；默认放在后面，是为了验收和角色行为分开。

1. 角色存储与校验。文件：`src/collaboration/role-models.ts`（新）、`types.ts`、`roles.ts`、`preset-roles.ts` 仅当种入比较需要从「整文件字符串」改为「无围栏才比较」时（比较逻辑放在 `roles.ts` 的 `seedPresetRoles` 即可，预置文本不必改）、`tools.ts` 的 schema。验收：上一节存储与种入测试。旧的无围栏角色测试仍绿。
2. 派发传模型与临时指定。文件：`dispatch.ts`，face 上的空游标表由 `entry.ts` 创建并经现有 `routerCollaboration` 注入进工具依赖。验收：字节级缺省、`agentOptions` 形状、临时指定、`continue` 拒绝。此步可以先只登记游标、不监听失败。
3. 失败观察、换模型、再投递、报告与受阻。文件：`src/collaboration/model-switch.ts`（新）、`entry.ts`（机会式 `on` / `agents` / `subagents`）、`dispatch.ts`（创建成功后 `map.set`）。验收：状态机测试。不 import `dsh-model-fallback`。
4. 协作页与 `GET` 清单。文件：`routes.ts`、`src/client/roles-tab.tsx`、`collaboration-api.ts`、`collaboration-store.ts`，以及客户端类型若从 `RoleTemplate` 导入则只改那一处定义。验收：路由与保存测试；三步交付留到这一步做。
5. 重挂修复。文件：`entry.ts`、`tests/collaboration/host-entry.spec.ts`。验收：卸载后再挂不抛 `<root>` 那句，第二次 face 是新的。
6. 门禁与产物。`npm run typecheck`、`npm test`、`npm run build`。然后第 1、2 步的宿主行与浏览器预检。桌面版由用户重开。不提交，除非实现任务另有说明。

## 替代方案与不采用原因

- 去改 `dsh-model-fallback`。D5 要求只做在 `dsh-router`，插件互不依赖。该插件的运行时是 `agent/request` 里替换路由，再在 `agent/request-error` 返回 `{kind:'retry'}`（`dsh-model-fallback/src/index.ts` 1–14 行），在同一步里重试，违反 D2。它的范围是日程投递开出来的会话，不是角色模板。它的 `classify.ts` 只借用四类名字：额度、限流、网络、服务端。本插件按稳定 `code` / `status` 自己判断，不链接它的冷却和正则。
- 每一步都回头试首选。违反 D8。同一次子会话留在用通的候选上，失败过的不再试；新派发重新随机取起点、按轮转顺序走（起点之前的那几项排在末尾，走完一圈即穷尽）。
- 没配候选就拒绝派发。违反 D6。没配就保持今天的调用形状。
- 用 `session.selectModel` 给子会话换模型。桌面版会 `saveSelection` 写部署默认，违反 D4。官方 869–874 行也写了后台保存默认。
- 把候选写进 `description` 正文或 YAML front matter 并把正文仍当整文件。会污染 `composeDispatchInstruction` 和 `dutySummary`，也会让 `seedPresetRoles` 的精确比较把「只加了模型的预置角色」当成用户改过或反过来在升级时抹掉候选。

## 退回

无。模型 id 与参数错误撞码这一支已由用户定成 D11，不再退回。

## 未知项

1. 内容被拒没有单独的 `LlmFailure.code`。在观测到之前，凡不是通道码、不是 `NO_ADAPTER`、也不是 `aborted` 的错误都不切换。观测：让一个子会话因为内容被拒结束一轮，记下 `turn/end` 的 `reason.kind` 与 `error.code` / `status` / `message`。不要先发明码名。
2. 已注册适配器遇上不存在的 model id 时，`turn/end` 的 `code` 仍可能不是 `INVALID_REQUEST`。D11 只覆盖确认为 `INVALID_REQUEST` 的那一支；其他码按 D7 的表，不因为「猜它是模型不存在」而切。桌面验收可以记下真实 code，但不阻塞实现。
3. 官方 `Agent` 类型没有 `.model`，桌面版循环有。若运行中的子会话上 `agent.model.select` 不是函数，按「受阻、不用 `selectModel`」处理。桌面验收时确认它是函数。
4. （已反转，见「协作页清单从哪读」）`sessionController.modelCatalog()` 的实现体已按 groups/failures 形状接入 /router/collaboration/models，页面已依赖它；不要按旧稿再写「页面不依赖它」。
5. `startActivation` 对未注册 provider 是立刻抛 `NO_ADAPTER`，还是仍返回 `childId`、等第一轮 `turn/end`。观测：临时指定一个未注册 provider 派发一次。在此之前，`startActivation` 抛错就原样上抛，不在派发函数里循环候选。
6. `turn/end` 写入时子会话往往还不是 `idle`（时序图是先 `turn/end` 再 `agent/status` idle）。方案按图等待。若桌面版上 `turn/end` 之后长期没有 idle，不发明超时、不因此标受阻、不向 running 投递；这一笔停在 `switching`，直到看到 idle 或条目卸载。
7. 轮次错误之后，子会话是否仍在 `agents` 注册表里，以及父会话 `agents.get` 会不会是空的。两者为空都不 `resume`。父级为空时不投递。
8. 提供方 `retryPolicy.mode === 'always'`，或自定义码表把通道码一直重试下去时，`turn/end` 可能迟迟不来。这与「等宿主放弃再切」一致，不另定策略。

## 自检

| 新增物 | 映射 |
| --- | --- |
| 角色 md 文末候选围栏，`RoleTemplate.models` | D1、D3 |
| 无围栏则派发不带 `agentOptions` | D6 |
| `router_dispatch` 拒绝 `provider` + `model`（模型由角色候选决定） | D3 的临时指定已退役 |
| 只对子会话 `startActivation` 传 `{provider, model}` | D4 |
| face 上的进程内游标，只前进，新派发重新随机取起点并轮转 | D8 |
| 入口 `session/event` 监听，等 `turn/end` 再 `select` 再 `sendMessage`；无定时器 | D2 |
| 固定继续句 + `kind: 'report'` 的切换记录 | D2 |
| 序列走完或无法安全继续时任务 `受阻` | D9 |
| 不调用 `selectModel`，不改主会话模型，不写 `reasoningEffort` | D4 与派生规则 |
| 不 import `dsh-model-fallback`，分类只用 `code`/`status` | D5、D7 |
| `INVALID_REQUEST` 只在当场 `listModels` 成功且 id 不在其中时前进 | D11 |
| 重启或重挂后不重建游标、不拨回第一个 | D8；无新持久化 |
| 有围栏的角色文件不参与预置升级 | 现有「用户改过不覆盖」+ D3，避免候选被种入抹掉 |
| `apply` 调用 `provide` 的释放函数，并 abort 监听 | D10 |
| `GET /router/collaboration/models` 与角色区手工填写 | D3 |

没有映射不到 D1–D11 的新状态、新持久化或新后台生命周期。没有共享冷却、没有推理强度、没有同一步重试、没有主会话模型切换。
