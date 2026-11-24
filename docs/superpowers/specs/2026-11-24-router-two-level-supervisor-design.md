# Router 两级模型设计：主会话直接担任主管

> 状态：**已实现**（2026-11-24）。本文件取代
> [`2026-11-16-router-lightweight-design.md`](./2026-11-16-router-lightweight-design.md)
> 的「角色与通信」「角色模板」「工具与调用顺序」三节；该文的存储、展示、异常与恢复、
> 明确排除等章节继续有效。`docs/requirements.md` 已同步为同一设计。

## 1. 动机

三级模型（用户↔Router↔主管↔成员）里 Router 只做「理解需求 + 派给主管」，而「理解意图、搞清
细节、思考周到、然后分派」本来就是 Router 的定位——再套一层主管是多余的中转：多一次派发、多一份
上下文传递、多一处失真。2026-11-24 起把主管的职责并回 Router 主会话：**Router 自己组队、派发、
跟进、汇审**，子会话一律是执行型 worker，报告链变成两级：**用户↔Router↔worker**。

同时解决三个用户诉求：

1. 每次派任务给子会话都能**新建任务并把子会话关联到任务**——派新任务时建新子会话，追加或修改
   需求时知道该发给哪些子会话；
2. 每个任务完成时主会话**自动压缩**；
3. **任务描述驱动上下文**：每次派发都要求主会话更新任务描述，插件据此更新主会话的上下文。

## 2. 决策（用户已拍板）

| 决策 | 选择 | 落点 |
|---|---|---|
| 「主管」角色去留 | **退役**，不再可派发；组织纪律并进 Router 提示词 | `prompt.ts`「按任务类型组队（八类）」「复杂度分级参考」；`RETIRED_PRESET_ROLES` |
| 派发建任务的形式 | `taskId` **可选**：给了在该任务下派发；省略则自动建任务（`taskTitle` 必填，`parentTaskId` 可选→挂父任务下） | `dispatch.ts` |
| 自动压缩触发信号 | **子会话 settle**（DSH 运行时事实 `subagent-settled`），同一轮去重，在 `agent/turn-stopping` 执行 | `compaction-trigger.ts` |
| 任务描述驱动上下文 | **注入活跃任务的完整描述**（不是摘要）+ 子会话；每步重渲染、原地替换；配合自动压缩 | `active-tasks.ts`、`context.ts` |

## 3. 派发契约（`router_dispatch`）

参数：`rootSessionId`、`role`、`task`、`mode` 必填；`taskId` / `taskTitle` / `parentTaskId` /
`expectedChildId` 按模式可选。

- **spawn / fork（新建）**：先读角色（无副作用，角色不存在什么都不写）；再解析归属任务——给了
  `taskId` 用它（任务必须存在），省略则 `records.create(kind=task, parentRecordId=parentTaskId)`
  自动建一条；然后经 subagents 服务创建子会话（初始指令含职责、任务、**本任务 taskId**、根会话、
  两级报告链），最后登记分工记录（`assignment.sessions=[childId]`，待处理）。返回
  `{childId, taskId, createdTask, record}`；登记失败返回 `childId + recordError`（子会话已存在不丢）。
  spawn 失败时自动建的任务会留下——这是**准确的**（任务存在、尚未派发），模型可带 `taskId` 重派。
- **continue（追加）**：`expectedChildId` 必填。在所有分工记录里找 `sessions` 含该子会话的，
  **必须唯一**（零个→拒绝「没有登记」；多个→拒绝「归属不唯一」，不猜）。找到后把追加要求
  **自动拼进归属任务的描述**（`[追加要求]` 分隔），再向该子会话投递；回执为空/投递抛错都报错，
  不换队、不新建。
- 旧的「continue 仅限主管」「已登记主管不能新建」「首次派主管必填 teamAdvice」全部删除。

语义上「一个子会话一条任务」就省略 `taskId`；「一个需求多条分工共用一条任务」就给 `taskId`。
追加需求时先用 `router_record_list(taskId, kind=assignment)` 查出子会话，再 `continue`。

## 4. 自动压缩（`@goodjin2/dsh-router/compaction-trigger`）

宿主 `ctx.compaction.compactNow(agent, signal)` 可编程触发压缩，但**要求 agent 空闲**（忙时抛
`busy`），且压缩服务在预设的 `isolate: { compaction: true }` 组里——组外的行解析不到它。因此：

- 新增一行，**挂在 compaction isolate 组内**（`cordis.patch.yml`，由 `gen-patch-yml.mjs` 生成）；
- 监听 `agent/inbox/inserted`：消息 `source.kind === 'subagent-settled'`（宿主把子会话结束作为
  notice 投进父会话收件箱）→ 给该 agent 记「待压缩」（`Set` 去重，同一轮多个子会话结束只压一次）；
- 监听 `agent/turn-stopping`（该轮无工具/steering 后续、即将空闲）：有标记的 agent 才调
  `compactNow`，调完清标记；用本行自己的 lifetime signal（不用回合的 abort signal，否则回合结束
  会取消压缩）；
- `busy / cancelled / changed / summary / commit / persistence` 一律吞掉并 `logger.warn`
  （`turn-stopping` 是 serial 模式，穿透会卡住整轮收尾）；监听器注册失败也吞（预设树不回滚）。

「任务完成」的信号是 DSH 运行时事实（子会话结束），不是模型自觉、也不是退出码推断——与
「插件不从会话结束推断业务完成」不冲突：这里只触发压缩这个维护动作，不改任何业务标签。

## 5. 任务描述驱动的上下文（`active-tasks.ts` + `context.ts`）

协作上下文段（`systemPrompt.context`）**每步重渲染、原地替换、不进历史**。往里注入**活跃任务**：
只收 `workLabel` 不是「已报告」的任务（无标签视为未报告=活跃），按创建序，上限 `maxTasks`（默认 5），
每条带**完整描述正文**（用户选择）和它下面登记的子会话（`assignment.sessions`），并提示
`router_dispatch(mode=continue, expectedChildId=…)` 的追加方式。

`text()` 是同步回调，不能 `await` 记录读取；TTL 会有一拍滞后。做法：共享服务
（`routerCollaboration`）里放一份按 `rootSessionId` 键的视图缓存，**tools/dispatch 行每次成功写
记录后 `await` 刷新**（几份小 JSON，代价可忽略），context 行同步读——写完立刻新鲜，零滞后。
缓存没有（刚启动/首次装配）就后台刷一次并渲染「加载中」。

与自动压缩配合：压缩摘要可能丢细节，但活跃任务的完整描述始终在上下文里——**把关键决策写进
任务描述而不是只留在对话里**，这是模型给「压缩后的自己」留状态的方式。

只对根会话生效：context 行把当前会话当作 root 去 `records.list`；worker 的任务正文已在它的
派发初始指令里，不重复注入。

### 明确不做：用模型写的文本直接替换历史

公开压缩 seam 的摘要由后端（LLM）生成，不接受调用方提供摘要；要自己写 `surfaceOp: replace`
得走低层会话改写，风险高，而且「注入 + 压缩」两招已经达成目的。

## 6. 角色库 v3

预置角色 16 → **15**：「主管」退役。退役逻辑（`RETIRED_PRESET_ROLES`）：种入时若磁盘上的
`主管.md` 内容等于它任一版历史文本（v1 摘要 / v2 / v3 含「一律用 fork」）→ 删除；用户改过的
**永远不动**（宁可留一个孤立角色）。`RoleStore` 为此新增 `remove(name)`。

## 7. 记录存储的一处语义澄清

`parentRecordId` 按种类分：**任务的父只能是另一个任务**（跨任务层级，派发时自动建的子任务挂在
主任务下）→ 核父任务存在；非任务记录的父是同任务内记录（报告挂在分工下）→ 核同任务记录存在。
此前任务从未用过 `parentRecordId`（旧校验下不可能通过），故向后兼容。

## 8. 验收与边界

- 门禁：`npm run typecheck` + `npm test`（含 `compaction-trigger.spec`、`active-tasks.spec`、
  dispatch 两级契约、roles 退役与 `remove`、context 任务注入与行接线、records 父子语义）+
  `npm run build`；`check-subrows` / `check-collaboration-host` / `check-collaboration-client` /
  容器 `check-host-rows` 双宿主全绿。
- 真实宿主上 `compactNow` 在 `turn-stopping` 时机是否总成功，只有桌面版实机能证；失败路径
  已全部吞掉并告警，最坏是「这次没压」。
- `maxDepth` 仍为 2：worker 仍可为自己的子任务派发一层 helper。
- 明确排除：任意成员互通网络、任务图调度、自动验收、用模型文本替换历史。
