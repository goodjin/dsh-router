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
2. 主会话能**压缩**历史（原诉求是「任务完成时自动压缩」；实现后用户改为「模型主动调工具、只压上次压缩以来、用任务列表表示」，见 §4）；
3. **任务描述驱动上下文**：每次派发都要求主会话更新任务描述，插件据此更新主会话的上下文。

## 2. 决策（用户已拍板）

| 决策 | 选择 | 落点 |
|---|---|---|
| 「主管」角色去留 | **退役**，不再可派发；组织纪律并进 Router 提示词 | `prompt.ts`「按任务类型组队（八类）」「复杂度分级参考」；`RETIRED_PRESET_ROLES` |
| 派发建任务的形式 | `taskId` **可选**：给了在该任务下派发；省略则自动建任务（`taskTitle` 必填，`parentTaskId` 可选→挂父任务下） | `dispatch.ts` |
| 压缩怎么做 | **不自动压**：给主会话一个 `router_compact` 工具，行为规则引导何时压；只压**上一次压缩以来**的已闭合回合，检查点是**任务列表** | `compact.ts`（住在 tools 行） |
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

## 4. 压缩：模型主动调 `router_compact`（不自动）

第一版做成「子会话 settle → 自动压缩」触发器行，用户改为主意：**不自动压**，给主会话一个工具、
在行为规则里引导，而且对压缩内容有两个硬要求——**只压上一次压缩以来的多轮对话**、**用任务列表的形式表示**。
查宿主事实后，这两个要求决定了不能走宿主自带的摘要器：

- 宿主 `compactNow` 每次 `selectCompactableRange` 都从 surface 第一个非系统节点重新选范围，摘要器
  指令还要求「把 PRIOR checkpoint 合并成一份累积摘要」——它是**累积**的，不是**增量**的。
- 摘要器指令是写死的八段英文结构（`COMPACTION_INSTRUCTION` 常量），没有任何注入口——做不出
  「任务列表」。

所以工具自己做，三步，全部走公开 API，**不再需要 compaction isolate 组里的独立行**（删掉了触发器行）：

- **选范围**（`findCompactRange`）：起点 = 上一份检查点（`isCompactCheckpointSource` 认得的
  user/message）之后的第一个 surface 节点（没有检查点则跳过 `system/message` 头）；终点 = 当前回合
  （最后一个 `turn/start`）之前的最后一个 surface 节点——**只压已闭合的回合**，当前这轮（含本次
  调用）一个字不动；终点再按工具调用/结果配对回退（`toolPairingBalancedBefore`），宁可不压也不切开
  任何一对。没有可压内容返回 `compacted:false`（不是错误）。
- **生成检查点**（`renderTaskListCheckpoint`）：**任务列表**直接从工作记录生成（全部任务含已报告：
  状态、一句目标、子会话、最近报告；子任务缩进挂在父任务下）——确定性、不花一次模型调用；模型用
  `notes` 附上几条「自上次压缩以来的关键决策/发现/用户纠正」，补记录里没有的对话结论。外层套
  `<compacted-summary>`：宿主摘要器之后若因压力再压，会按它的规则把它当 PRIOR checkpoint 合并。
- **落地**：按宿主压缩事务协议写三条事件——`compaction/start`（`turn:null`，独立手动尝试）→ 一条带
  `surfaceOp: {op:'replace', startSeq, endSeq}` 与 `sourceEventSeqs`（全部被遮蔽节点）的 user/message
  （`createUserMessage` 构造，source 用 `compactCheckpointSource(CompactionId(uuid))`，UI/日志据此
  认成检查点）→ `compaction/end`。中途失败也写 `end(error)`，不留悬空锁。

行为规则（`prompt.ts`「上下文与压缩」）引导：什么时候压（一个任务收到报告处理完之后 / 连续几轮讨论
尘埃落定之后 / 历史很长还不想结束时）、一个任务压一次、**压之前先把关键决策写进任务描述**（检查点
来源是记录，对话里没进记录的只有 notes 能带走）、`compacted:false` 别重试。

宿主自己的压力压缩仍然存在（上下文溢出时的安全网），它走自己的累积摘要；本工具是模型主导的、
结构化的那一层。

## 5. 任务描述驱动的上下文（`active-tasks.ts` + `context.ts`）

协作上下文段（`systemPrompt.context`）**每步重渲染、原地替换、不进历史**。往里注入**活跃任务**：
只收 `workLabel` 不是「已报告」的任务（无标签视为未报告=活跃），按创建序，上限 `maxTasks`（默认 5），
每条带**完整描述正文**（用户选择）和它下面登记的子会话（`assignment.sessions`），并提示
`router_dispatch(mode=continue, expectedChildId=…)` 的追加方式。

`text()` 是同步回调，不能 `await` 记录读取；TTL 会有一拍滞后。做法：共享服务
（`routerCollaboration`）里放一份按 `rootSessionId` 键的视图缓存，**tools/dispatch 行每次成功写
记录后 `await` 刷新**（几份小 JSON，代价可忽略），context 行同步读——写完立刻新鲜，零滞后。
缓存没有（刚启动/首次装配）就后台刷一次并渲染「加载中」。

与 `router_compact` 配合：检查点是任务列表、活跃任务的完整描述又每步注入——**把关键决策写进
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

- 门禁：`npm run typecheck` + `npm test`（含 `compact.spec`、`active-tasks.spec`、dispatch 两级契约、
  roles 退役与 `remove`、context 任务注入与行接线、records 父子语义）+ `npm run build`；
  `check-subrows` / `check-collaboration-host` / `check-collaboration-client` / 容器 `check-host-rows`
  双宿主全绿。`check-collaboration-host` 会在两个宿主里真实 import `dist/tools.js`，证明
  `@deepseek-ai/dsh-compaction`、`/checkpoint`、`dsh-llm` 三个宿主侧导入在运行时解析得到。
- 真实宿主上 `session.append(..., {surfaceOp: replace})` 的落地效果（UI 折叠、后续宿主压力压缩
  认出 PRIOR checkpoint）只有桌面版实机能证；范围与配对规则有单元测试覆盖。
- `maxDepth` 仍为 2：worker 仍可为自己的子任务派发一层 helper。
- 明确排除：任意成员互通网络、任务图调度、自动验收、用模型文本替换历史。
