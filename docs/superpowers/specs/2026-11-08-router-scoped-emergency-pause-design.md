# Router 作用域紧急暂停 设计（scoped emergency pause）

> 本文是 2026-11-08 用户指示的落地设计：紧急暂停只停当前 Router 派出去的活，
> 不再冻结全局派发；全局熔断保持全局且自动。

## 1. 背景：为什么 Router 会话不能执行任务

现场（2026-11-08 复核）：

- `~/.dsh/router/guard-state.json` 落着 `{"frozen": true, "reason": "user-emergency",
  "frozenAt": 1794053010634}`——旧版「紧急暂停」写下的**全局**冻结标记。
- 该文件是宿主启动时读的持久化状态（熔断器 `ensureLoaded`），所以每次启动
  都恢复成「已冻结」。
- 核心派发入口有一道闸：冻结时一切派发被拒，报错文案是
  `派发已冻结（user-emergency）：请停止重试并向用户报告`。
- 于是 Router 会话派不出任何任务。**根因 = 一个持久化的全局冻结标记，
  不是任务本身出了问题。**

还有一个让用户没法自救的次生缺陷：界面上那个按钮会不会显示「解除冻结」，
是用「有没有一张带 `unfreeze` 动作的通知卡」推断出来的，而**任何代码路径都不会
产出带 `unfreeze` 的卡**。所以按钮永远显示「紧急暂停」，用户看不到「解除冻结」。

账本现场（`~/.dsh/router/ledger.json`，18 条）：13 条 `cancelled`、5 条 `blocked`
（5 条都是 supervisor、有会话）。**没有任何一条在跑**——真正卡住的是派发闸门，
不是有活停不下来。

## 2. 用户指示（逐字）

> 紧急暂停只暂停从当前router派出去的活，不暂停其他，也不做标记不影响后面新派活，
> 不作为一个持久化的全局设置。

配套澄清（用户逐条确认）：

1. **范围**：当前 Router 派出去的任务 **及其下游子任务**（主管再拆的那一层也算）。
2. **停止方式**：停掉的任务记成「已暂停」，可恢复。
3. **不动熔断**：紧急暂停**不碰**全局熔断；熔断保持全局且自动。

据此有三条硬约束：

- **C1 作用域**：只停当前 Router 会话派出的活；别的 Router 会话的任务不碰。
- **C2 无全局标记**：紧急暂停不写任何全局持久化状态；之后的新派发不受影响。
- **C3 不碰熔断**：全局熔断（infra 失败风暴 / 创建风暴）保持原样，全局且自动。

## 3. 设计

### 3.1 作用域怎么算（派发树归属）

账本原来只记了「父任务」（`parentId`，且是模型自己填的），没记「谁派的我」。
新增字段 `dispatchedBySessionId`：派发时由宿主记下**发起派发的那个会话 id**
（`core.dispatchTask` 唯一注入口，`callerSessionId`）。

于是派发树是这样一条链：

```
Router 会话 R ──dispatch──▶ 任务 T1（主管型，会话 S1）
                                S1 ──dispatch──▶ 任务 T2（子任务）
```

- T1 的 `dispatchedBySessionId = R`，T1 的 `sessionId = S1`。
- T2 的 `dispatchedBySessionId = S1`（主管在 S1 里派发）。

「R 的派发树」= 从 R 出发、沿着「派发者会话 → 该任务的执行会话」反复闭包出来的
任务集合。纯函数 `scopedPauseTargets(records, routerSessionId)` 负责算，规则：

1. 分发者会话集合初始 = `{ R }`。
2. 取 `dispatchedBySessionId` 落在集合里的任务；它们的 `sessionId` 并入集合，重复。
3. 只保留**在跑的**：`status ∈ {dispatched, running}` 且有 `sessionId`。

用会话而不是 `parentId` 归属，是因为 `parentId` 由模型填写、可能漏填或填错；
`dispatchedBySessionId` 由宿主记，事实性强。

### 3.2 停的动作与顺序

每个目标任务（逐个如实上报）：

1. **先落账本**：状态置 `paused`（账本优先）。
2. **再断会话**：对执行会话发中断（`agents.cancel`，原因留痕）。

账本优先的理由：worker 可能在收尾时抢先交完成。`paused` 的出边只有
`running`/`cancelled`，没有 `completed`，所以**迟到的 complete_task 会被状态机
当场拒掉**，不会把已暂停的任务改成已完成。

注意：活着的任务状态是 `dispatched`（不是 `running`——`running` 只在系统判定
转执行、恢复、驳回返工时才出现）。而迁移表里 `dispatched` 的出边原本没有
`paused`，所以**必须给 `dispatched` 补一条 `→ paused` 边**，否则暂停根本落不下去。
顺带修好一个现存毛病：`control_task pause` 对 `dispatched` 的任务原本会抛
「非法状态迁移」，现在能正常暂停。

两阶段执行：先把所有目标置 `paused`，再统一断会话——任一任务都不会在别的任务
还没落账本时被抢完成。落账本失败的任务**不**断它的会话（如实报失败）。

### 3.3 恢复路径

`paused` 的出边有 `running`，所以现有的 `control_task resume`
（`core.controlTask` 的 resume 分支：落 `running` + 给执行会话投递「已恢复」
通知）就是恢复路径，不新增机制。恢复后 worker 交完成走 `running → completed`，
合法。

### 3.4 通知

- **面向用户**：每个被暂停的任务写一张异常卡（打开会话 / 取消任务 / 知道了），
  卡片带 `taskId`，用户能跳到会话或直接取消。**不再写全局的「派发已冻结」卡。**
- **面向模型**：给当前 Router 会话投递一条「已暂停，等用户指示」的告知
  （`bridge.notify`，steer）。只是告知，不硬拦——新派发仍然允许（C2）。

报告里同时带逐任务如实结果与「是否已通知到 Router 会话」。

### 3.5 熔断与旧标记

- **熔断不动**：紧急暂停不再调用 `breaker.freeze`。`user-emergency` 这个手动
  冻结原因从产品里消失。
- **旧标记自动作废**：`guard-state.json` 里 `reason === 'user-emergency'` 的冻结态
  只可能来自旧版手动暂停，新版本永远不写它。熔断器装载时识别这个遗留原因并
  **丢弃冻结态**（并回写文件），让用户重启桌面版后直接恢复派发能力，不必手工改
  JSON。自动冻结原因（infra 失败风暴 / 创建风暴）照旧恢复。
- **界面显示真实冻结态**：把真实熔断态投影进 `RouterState.breaker`，界面据此
  显示「解除冻结」。自动冻结发生时用户能自己解冻，不再依赖那张永不出现的卡。

### 3.6 界面按钮

通知浮窗顶部从「一个二选一的按钮」改成两个：

- **「暂停本 Router 任务」**（常驻）：做作用域暂停。
- **「解除冻结」**（仅当 `RouterState.breaker.frozen` 为真）：解全局熔断。

### 3.7 路由与客户端契约

`POST /router/emergency-pause` 现在收 `{ routerSessionId }`（必填，字符串）；
宿主校验它是已登记的 Router 会话，否则 400。响应：

```ts
interface EmergencyPauseTaskResult {
  taskId: string
  title: string
  sessionId?: string
  paused: boolean        // 账本是否已置 paused
  interrupted?: boolean  // 会话是否已中断
  detail?: string        // 未完成的原因（如实）
}
interface EmergencyPauseReport {
  tasks: EmergencyPauseTaskResult[]
  pausedCount: number
  failedCount: number
  notified: boolean
  notifyDetail?: string
}
```

客户端调 `api.emergencyPause(routerSessionId)`；浮窗在 Router 会话视图里才有，
此时 `currentSessionId` 就是当前 Router 会话 id，直接带上。

## 4. 诚实边界

- **派发溯源只对本次改动之后派出的任务生效**：旧账本行没有
  `dispatchedBySessionId`，无法归属到任何 Router 会话，因此不会被暂停。现场那
  5 条 11-07 的受阻 supervisor 属于这一类，得逐条处理。
- 熔断仍可能因 infra 失败风暴 / 创建风暴自动冻结（这是**全局且自动**的既定设计，
  本次不动），界面现在会显示「解除冻结」让用户自己解。

## 5. 现场发现的相邻缺陷（本次不修，单独记录）

活着的任务是 `dispatched`，而迁移表里 `dispatched` **没有** `→ completed` 边。
于是 worker 主动交完成时 `ledger.complete` 会抛「非法状态迁移：dispatched →
completed」——判定器那条路（先落 `running` 再交完成）能过，worker 自己交不能过。
现场账本 18 条里 0 条 `completed`，与此吻合。

本次修的是「能不能派发」（闸门被冻）与「暂停语义」，不顺手改完成语义
（会牵动验收策略与提示词，属于另一个设计决定）。修法很小：给 `dispatched` 补
`→ completed` / `→ review-pending` 两条边 + 补测试。单独做。

## 6. 影响面

| 文件 | 改动 |
| --- | --- |
| `src/shared/types.ts` | `TaskRecord` 加 `dispatchedBySessionId?` |
| `src/host/ledger/store.ts` | `NewTaskInput` 加 `dispatchedBySessionId?`；建任务时落库 |
| `src/host/ledger/machine.ts` | `dispatched` 补 `→ paused` 边（合法对 28→29） |
| `src/host/guard/breaker.ts` | 装载时作废遗留 `user-emergency` 冻结标记 |
| `src/host/guard/emergency.ts` | 重写为作用域暂停（纯函数算范围 + 编排） |
| `src/host/core.ts` | 派发时记派发者会话；`workbench.state()` 投影熔断态 |
| `src/host/routes.ts` | 紧急暂停路由收 `{ routerSessionId }` 并校验 |
| `src/entry.ts` | 重新接线作用域暂停；删掉手动冻结；校验 Router 会话 |
| `src/shared/view-contract.ts` | `RouterState.breaker?`；暂停报告类型 |
| `src/client/api.ts` | `emergencyPause(routerSessionId)` |
| `src/client/notification-model.ts` | 冻结态改读 `RouterState.breaker` |
| `src/client/notification-cards.tsx` | 拆成「暂停本 Router 任务」+「解除冻结」 |
| `src/host/prompts/router.ts` | 补一句作用域暂停的语义 |
