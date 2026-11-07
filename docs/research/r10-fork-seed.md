# r10：DSH「带历史分叉/seed 创建新会话」宿主面查证（fork + seed + preset 组合）

调查时间：2026-11-07。只读研究，未修改任何被研究对象。

## 0. 资料源与行号约定

- 桌面版 `dsh 0.2.2-rc.1`：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 整体解包到 **`/tmp/dsh-asar-r10/`**。下文 `asar:` 路径 = `/tmp/dsh-asar-r10/dsh/node_modules/@deepseek-ai/<包>/lib/…`，行号即归档内真实行号。
- CLI 版 `dsh 0.2.1-rc.2`：`~/.local/share/node-v24.18.1-darwin-arm64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`，下文以 `cli:` 标注，仅作对照。
- 承接 r1/r2：`session/create` 参数全集为 `workspaceId | cwd`（互斥）+ `sessionId?` + `agentPreset?`，**无 title、无 seed**（r2 §1.1；本轮复核未变）。

---

## 1. UI 会话分叉链路（按钮 → client 命令 → 宿主方法 → 底层原语）

完整链（桌面版；CLI 版同名同构）：

1. **入口**：workspace 侧栏会话菜单项「分叉会话」，注册于 `asar:dsh-client-ui-workspace/lib/client.js:4366-4374`（`register("fork", 300, ["session/fork"], …)`，权限门控 `session/fork`，`commandId: "session.fork"`，点击 → `actions.forkSession(target.sessionId)`）。另有键盘快捷键 `session.fork`（KeyF，primary+alt / primary+shift）：`client.js:166` 注册、`client.js:179-182` 调 `navigation.forkSession(target.id)` 并对 `SessionForkError` + `session/fork-unavailable` 做静默降级提示（`client.js:4675`「无法分叉会话」/`:4694`「请先打开原会话完成迁移」）。`dsh-client-ui-conversation/lib/client.js` 内无 fork 入口（已 grep 证实）。
2. **client 包装**：`client.js:1494-1500` `forkSession(sessionId, onCreated, options)` → `this.sessions.fork({ sessionId, increaseTitle: true, onCreated?, allowMigration? })`。
3. **client manager**：`asar:dsh-api-session-controller/lib/client.js:3984-4008` `fork(opts)`：读源标题（increaseTitle 用）→ `remote.session.fork({sessionId, atSeq?, allowMigration?})` → 成功后 `onCreated(childId)` → 若有源标题则 `manager.rename(childId, increasedForkTitle(sourceTitle))`（`:4003-4005`，改名失败抛错）。`increasedForkTitle`（`client.js:3731-3740`）：尾号 `(N)`/`（N）` 递增，无号则追加 ` (1)`。**标题递增是纯客户端行为**，host 不参与。cli: 同构（`cli:…/client.js:3714, 3980-4003`）。
4. **wire 命令**：`'session/fork'` 注册于 `asar:dsh-api-session-controller/lib/typert.host.js:2086-2110`（→ src: `packages/api/session-controller/src/index.ts`），Remote 包装 `index.js:4036-4041`（`allowMigration === false` 且源会话持久化格式为 `migration-required` 时抛 `session/migration-required`——对应 UI 那条「先打开原会话完成迁移」提示）。cli: `cli:…/typert.host.js:1588`、`cli:…/lib/index.js:3206-3209`。
5. **宿主实现**：`SessionCommandController.fork(request)` — `asar:…/lib/index.js:756-823`。步骤：
   - `atSeq` 校验（非负安全整数）；
   - `ctx.sessionQuery.observeSession(sessionId)` 冷读源日志（`:768`）；
   - `boundary = atSeq ?? latestCompletedPrefixBoundary(source.events)`（`:777`；缺省函数在 `:635-646`：最后一个 `turn/end`，再吞掉其后直到下一个 `turn/start`/新 `user/message`/`agent/inbox/spliced` 之前的独立事件）；
   - `seed = buildForkSeed(source.events, boundary)`（`:779`）；
   - `workspace = await this.forkWorkspace(source.header)`（`:782`，见 §6）；
   - `childId = "session-" + randomUUID()`（`:786`）；
   - **底层创建原语**：`ctx.agents.create({ sessionId, seed, inheritedEventCount: SessionLogOffset(boundary+1), meta, agentOptions, setup })`（`:787-801`）；
   - `workspace.attachSession(childId)`（`:806-810`）。

**参数全集（wire strict schema，`typert.host.js:664-669`）**：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` | string（必填） | 源会话 |
| `atSeq` | number? | 精确含端截断 seq；**省略 = 最近一个完成轮次前缀**；可切在未闭合轮次中间（宿主补合成收尾） |
| `allowMigration` | boolean? | 默认 true；false 时先做格式迁移预检 |

返回仅 `{ sessionId }`。**没有 title、没有 workspace、没有 agentPreset 参数**——三者分别由客户端改名、`forkWorkspace` 自动解析、源会话 preset 决定（§3）。`increaseTitle` 不在 wire schema 里，是 client manager 层约定。

## 2. `CreateAgentOptions.seed` 能否从宿主面传入

**`seed` 不出现在任何 wire 命令的 schema 中**（全量 grep 所有包 `typert.host.js`，仅注释提及）。能传 seed 的只有宿主进程内的两层服务：

- **`ctx.agents.create(options)`**（服务 `agents`，`asar:dsh-agent/lib/index.js:579-590`，转发给 `dsh-agent-loop` 工厂）：options 形状（消费点 `asar:dsh-agent-loop/lib/index.js:1663-1676`）= `{ sessionId, seed?, meta?, inheritedEventCount?, agentOptions?, setup?, signal?, parentAgent? }`。**宿主自己的 fork 就是这么用的**（§1 第 5 步）——这就是「seed + 自选 preset 组合」唯一同框可行的调用点（§7）。
- **`ctx.sessions.prepare(id, {seed, meta, inheritedEventCount, eventState?})` / `ctx.sessions.create(id, options)`**（`asar:dsh-session/lib/index.js:1808-1848, 1781-1786`）：只造会话对象不造 agent；`meta` 可含 `{createdAt?, cwd?, parentSession?, isSeeded?, origin?, delegationDepth?, agentPreset?}`（`:1819-1830`）。注意：这里的 `meta.agentPreset` 只是**写进 header 的记录值**，真正的预设行挂载（`agentPresets.mount`）发生在 agent 工厂的 `setup` 里——单独走 sessions 层不会得到可运行的 agent。

**seed 形状与校验**（`asar:dsh-session/lib/types/index.js:486-560` 构造器）：
- 事件数组；每个事件 `data` 必须**无损 JSON 可序列化**（`:497-501`），`seq` 必须从 0 连续（`snapshot.seq === index`，`:502-503`，即「contiguous from seq 0」），逐事件过 `surfaceManager.validateNext`（`:508-514`）——与 live append 同一套不变量；
- `header.isSeeded=true` 必须显式给 seed 和 `inheritedEventCount`；未 seeded 时 count 必须为 0（`:524-528`）；count ≤ log 长；count 必须指向**最后一个** `session/end-seed`（`data.inherited===true`）标记（`:532-538`）；snapshot 模式下 seed 要么恰等于继承前缀、要么带标记（`:534-536`）。

**`buildForkSeed`**（`asar:dsh-session/lib/types/fork.js:22-30`，子路径导出 `@deepseek-ai/dsh-session/fork`，双版本逐字节一致）：拷贝 `[0..boundary]` 全部源事件对象（**保留原对象，原始日志**）→ 追加合成 `session/end-seed {data:{inherited:true}}`（seq=boundary+1）→ `openTurnClosers(prefix, {kind:'forked'})` 补合成收尾（`dsh-session/lib/types/repair.js:47-84`：未完成 tool call 补 `tool/result` 错误结果（forked 版文案明说「父会话可能在分叉点之后完成了它」，`repair.js:18-19`）→ 未闭合 `step/end` → `turn/end {reason:{kind:'forked'}}`；已平衡则不加）。

## 3. 预设组合由谁决定：换 preset 与 seed 同给是否允许

**会话层（wire）：不允许。** fork 实现里 preset 组合硬编码为源会话：`composition = await this.agents.composeAgent(this.agents.presetForObservation(source))`（`asar:…/index.js:787`）——`presetForObservation` 就是读源观察投影 `projections.values.agentPreset`（`:459-463`），`composeAgent(presetId)` 再 `agentPresets.resolve(presetId)` + `presets.mount` 进 setup（`:264-276`）。无参数可覆盖；`composeAgent(undefined)` 会落到部署默认 preset（`dsh-agent-preset-registry/lib/index.js:612-613` `wanted = id ?? this.defaultId`），但 fork 只在源**没有** preset 投影时才会走到这条。且 `resolve` 对已卸载的 preset id 直接抛 `agent-preset/not-found`（`:615-620`）——**源 preset 被删/改名后 fork 会失败**。
两个伴随事实：
- **模型不是继承死路**：`agentOptions:{provider,model}` 取 `agentDefaultModel.currentSelection()`（`:788-789`）只是后备；`AgentModel.current()` 优先读 `model/selection`/`request/header` 事件折出的 modelSelection 投影（`asar:dsh-agent/lib/index.js:141-190`）——seed 原样拷贝了源的 `model/selection` 事件，所以**子会话实际沿用源会话选过的模型**。
- **创建后没有任何 wire 命令能换会话 preset**：session 命令全集（`typert.host.js:1891-2610`，25 条）只有 `create/fork/rename/selectModel/…`，无 preset 切换；resume 也按观察投影重挂同 preset（`index.js:308`）。UI 的 `startSession(workspaceId, {agentPreset})`（`client-ui-workspace/client.js:1502-1517`）只在**新建**时生效。

**子代理层：明文禁止独立选 preset。** fork provider `ForkInProcessProvider`（`asar:dsh-subagent-fork-in-process/lib/index.js:32-52`）：`capabilities = { agentOptions:true, agentPreset:false, outputSchema:true, depthLimit:true }`、`inheritsParentContext = true`，seed = 父日志最后一个 `turn/end` 的平衡前缀（`completedTurnPrefix`，`:16-24`，**无 end-seed 标记、无合成收尾**——与 session 层 fork 不同）；能力断言 `dsh-subagent/lib/index.js:3327`：请求 `agentPreset` 且 provider `inheritsParentContext` → `SubagentError "does not support independent agent preset selection" (UNSUPPORTED_CAPABILITY)`。未显式选 preset 时子会话 header 落 `parent.ctx.get("agentPresets")?.composedPreset(parent.ctx)`（`:349-352, childSessionMeta :1450 附近`），恢复时只认「独立选择过」的投影（`:2179-2181`）。

**这一限制在会话层不成立**：`ctx.agents.create` 的 `seed` 与 `setup` 是两个独立 option，宿主自己的 fork 证明了同框可行——它只是**选择**让 composition 跟随源。插件直调该层即可同时给 seed + worker preset（§7）。

## 4. inheritedEventCount / seq 语义；压缩（shadowed）节点在分叉时的呈现

- **`inheritedEventCount = boundary + 1`**（`asar:…/index.js:790`）：继承前缀 `[0..boundary]` 的事件个数。子会话自己的第一个事件是 `session/end-seed` 标记（占 seq boundary+1），其后是合成收尾与新事件。
- **own/inherit 判定**：`session.isOwnSeq(seq) = seq >= inheritedEventCount && seq < seq`（`dsh-session/lib/types/index.js:596-598`）。投影/子代理身份据此区分「自己日志后缀」与「fork seed 重放的祖先内容」（`typert.host.js:150` 描述原话：`isOwnSeq(seq)` 证明身份来自 child 自己的后缀而非 fork seed 重放的祖先 descriptor）。
- **持久化**：子会话 JSONL 的 header 行写入 inheritedEventCount（`dsh-session-persistence-jsonl/lib/index.js:2465-2481` `create(header, {inheritedEventCount})` → `toHeaderLine`），继承事件本体随后照常 append 进子会话自己的日志文件——**子会话的磁盘日志物理上含全部继承前缀**，恢复时从 header 行解码 count（`fromRestore` 路径）。
- **模型可见面：继承的是原始日志、按同一条投影管线重放**，不是拷贝「模型可见面快照」。seed 逐事件过 `surfaceManager.validateNext`（§2），`compaction/start|summary|end|prune`、`feedback/message-put`（surface replace）等都在事件目录里（`dsh-session/lib/types/known-event-types.js:31,56,80-83`），前缀里这些事件原样带入，重放后子会话的可见面与源在 boundary 处一致——**已被压缩/替换遮蔽（shadowed）的旧节点留在原始日志里但被投影规则继续遮蔽**（`dsh-session/lib/types/surface.js:43`「model-visible surface deliberately shadows replaced ranges」）。`session/end-seed` 标记本身不产生 surface 节点（surface.js/tool-history.js 中无该类型分支）。
- 附：typert schema 里的 `forkLineage` 投影（`typert.host.js:256-261`）是 **liveshare 共享分支**的概念（`authoredByViewer/workspaceReadOnly`），与会话 fork 无关，勿混用。

## 5. 其他能「带历史建会话」的宿主面（逐个排除/确认）

| 宿主面 | 能否带历史 | 结论 |
| --- | --- | --- |
| wire `session/create` | 否 | strict schema 仅 workspaceId/cwd/sessionId/agentPreset（r2 §1.1 复核未变），additionalProperties:false。**排除** |
| wire `session/fork` | 是（seed 内建） | preset 锁定源会话，无覆盖参数。**确认（带限制）** |
| 服务 `ctx.agents.create` | **是** | `{seed, inheritedEventCount, meta, setup}` 全可传；宿主 fork 自用同款。**确认：唯一可「seed+自选 preset」同框的层** |
| 服务 `ctx.sessions.prepare/create` | 是（对象层） | 可给 seed+meta（含 parentSession/origin/agentPreset 记录值），但不建 agent、不挂预设行；需再配 agent 工厂。**半确认：底层砖块** |
| `sessionPersistence.create` | — | 只登记 header+count，事件由 live 会话写入；非建会话入口。**排除** |
| workspace 层 | 否 | `attachSession` 只入册（`dsh-workspace/lib/index.js:111-133`，r2 §1.2）；无 seed/create。**排除** |
| 子代理层 `ctx.subagents`（fork provider） | 是（平衡前缀） | preset 强制继承父组装，禁独立选（§3）。**不适合 worker 场景** |

## 6. 分叉会话的 prompt 投递、标题与 workspace 归组

- **投递**：fork 只建会话不投递；子会话创建后处于 idle，后续与普通会话完全一样走 `session/prompt`（queue/steer，requestId 幂等，r2 §2）。UI fork 后仅导航到子会话（`onCreated` → reveal），不自动发消息。
- **标题**：host 不复制标题字段；子会话标题来自 **seed 里重放的 `session/title` 事件**（等于源标题），UI 随即 `rename` 改写为 `标题 (N)` 递增版（§1 第 3 步；`session/title` last-wins）。**插件直调 `session/fork` 不会自动改名**，子标题=源标题。
- **workspace 归组**：`forkWorkspace`（`asar:…/index.js:986-996`）——找已含源会话的 workspace 直接用；源 `origin==="subagent"` 时沿 `sessionQuery.traceSession` 祖先链找第一个有 workspace 的祖先；都找不到返回 undefined → **子会话不入册**（重启后按 cwd 由 `bootstrap` 自动归组，r2 §1.2）。**插件无法指定目标 workspace**。CLI 例外见 §8。

## 7. 结论：「seed 原样 + 自选 worker 预设」是否成立

- **走 wire（插件从浏览器/Remote 发起）：不成立。** `session/fork` 无 preset 参数、无 title、无 workspace 参数；preset 由源会话投影决定且创建后无命令可换；`session/create` 有 preset 但不吃 seed。
- **走宿主服务（纯宿主侧插件直调）：成立。** 复刻宿主 fork 的五步即可：`ctx.sessionQuery.observeSession(源)` → `buildForkSeed(events, boundary)`（import `@deepseek-ai/dsh-session/fork`，exports 已暴露该子路径）→ 自行 `composeAgent(workerPresetId)` 或直接 `agentPresets.resolve+mount` 组 setup → `ctx.agents.create({sessionId: 自造, seed, inheritedEventCount: boundary+1, meta:{cwd: 源cwd, isSeeded:true, agentPreset: workerPresetId, parentSession: 源id}, agentOptions, setup})` → 需要归组时 `workspace.attachSession`。这正是宿主 fork 走的同一条原语链，只是把「preset=源」换成「preset=worker」。注意：该层无 Remote 权限门控，属宿主进程内能力；`agent-preset/not-found` 需自行兜底；继承历史里可能出现 worker preset 未装配的工具的 `tool/call` 记录（仅历史陈述，不要求工具在线，重放校验不受影响）。
- **若只能走 wire 的最近替代**：(a) fork 到子会话后在首条 prompt 里注入「身份/角色卡」提示词——preset 组合换不了，但模型的任务上下文可以换；此时子会话的技能/工具面仍是源的 preset，worker 化不完整；(b) 或放弃历史、`session/create` 用 worker preset 全新开 + `sessionQuery` 读源摘要作首条消息。**插件侧若坚持「完整历史 + 完整 worker 预设」，唯一路径是宿主侧直调 `ctx.agents.create`，提示词侧身份卡不是等价替代。**

## 8. 双版本差异表（0.2.2-rc.1 桌面 vs 0.2.1-rc.2 CLI）

| 面 | 桌面 0.2.2-rc.1 | CLI 0.2.1-rc.2 | 差异 |
| --- | --- | --- | --- |
| `session/fork` schema | `typert.host.js:664-669` | `cli:…/typert.host.js:508-511` | 一致（sessionId/atSeq/allowMigration） |
| fork 实现 meta | **无 `parentSession`**（`index.js:789-796`） | **写 `parentSession: 源id`**（`cli:…/index.js:883-890`） | **桌面版 fork 子会话在 `session/list` 行里没有 parentSessionId，会话层谱系不可见**；CLI 可见 |
| fork Remote 包装 migration 预检 | `index.js:4036-4041` | `cli:…/index.js:3206-3209` | 一致 |
| `buildForkSeed` / `repair.js` | `dsh-session/lib/types/fork.js` | 同 | 逐字节一致（diff 证实） |
| client fork 链（increaseTitle/递增改名） | `client.js:3984-4008, 3731-3740` | `cli:…/client.js:3980-4003, 3714` | 同构 |
| fork provider 能力 | `agentPreset:false, inheritsParentContext:true` | 同 | 一致 |
| `agents.create` seed 形状 | `dsh-agent-loop/lib/index.js:1663-1676` | 同构 | 一致 |

## 9. 关键证据索引（速查）

- UI 菜单/快捷键：`dsh-client-ui-workspace/lib/client.js:4366, 166, 179, 1494`
- client fork+改名：`dsh-api-session-controller/lib/client.js:3984, 3731`
- wire 注册+schema：`typert.host.js:2086, 664`
- 宿主 fork 实现：`dsh-api-session-controller/lib/index.js:756-823`（seed 组装 :779、preset 来源 :787、agents.create :787-801、attachSession :806）
- presetForObservation/composeAgent：同上 `:459-463, 264-276`；preset resolve 缺省/报错：`dsh-agent-preset-registry/lib/index.js:612-620`
- seed 校验：`dsh-session/lib/types/index.js:486-560`；isOwnSeq：`:596`
- buildForkSeed：`dsh-session/lib/types/fork.js:22-30`；合成收尾：`dsh-session/lib/types/repair.js:47-84`（forked 文案 :18-19）
- agents.create options：`dsh-agent/lib/index.js:579-590`；消费：`dsh-agent-loop/lib/index.js:1663-1676`
- 持久化 count：`dsh-session-persistence-jsonl/lib/index.js:2465-2481`
- 模型继承优先级：`dsh-agent/lib/index.js:141-190`（AgentModel.current）
- fork provider 限制：`dsh-subagent-fork-in-process/lib/index.js:32-52`；断言：`dsh-subagent/lib/index.js:3327`
- forkWorkspace：`dsh-api-session-controller/lib/index.js:986-996`
