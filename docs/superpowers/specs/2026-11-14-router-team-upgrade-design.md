> **归档说明（2026-11-19）**：本文出自已废弃的 router-team-v2 候选线（2026-11-13~15，未合入主干，代码与分支已清理）。
> 其设计已被《2026-11-16 Router 轻量协作设计》（本仓现行主线）取代。归档仅作教训清单与崩溃窗口对账思路的参考；
> 文内所有状态自述与日期均已过期，不得当作现状或能力证据。

# Router 团队化升级架构设计

- 日期：2026-11-14（Asia/Shanghai）
- 状态：待用户审阅；本文是目标设计，不是已实现能力或上线证明。
- 产品归属：`@goodjin2/dsh-router`。吸收 Agent Kernel 的设计，不新增跨插件运行依赖，不修改 Kernel 仓库。
- 实施计划：`../plans/2026-11-14-router-team-upgrade-plan.md`
- 团队交接：`../plans/2026-11-14-router-team-execution-handoff.md`
- 审批边界：用户已明确升级目标与由智能体团队执行的方式；本轮交付方案。方案审阅确认后才能启动产品代码重构。

## 1. 已确认目标与本方案的设计选择

### 1.1 用户已确认的目标

1. 将 Agent Kernel 的任务协议设计融合进 Router，以 Router 为唯一产品。
2. Router 接收用户任务，分派给各主管管理，主管组建团队执行；业务层级为 Router → supervisor → worker。
3. 保留一个用户可选择的入口 preset，不给每个角色创建 preset。
4. 角色既能由用户手动创建，也能由模型在执行中创建。
5. 受管 Agent 的完整系统提示词由我们统一掌控，不采用原生人设上简单追加角色的方式。
6. 正常结果优先、主动地由执行会话调用报告工具提交。不能把自然停止、空闲、外部总结或一段“完成了”视为成功。
7. 方案覆盖架构、细节、健壮性及可交给团队执行的分工。

### 1.2 提交审阅的设计选择

- 新任务一律先交主管；简单任务允许主管自行执行 `self` 节点，不强制创建多名 worker。事实问答仍由 Router 直接回答，不建任务。
- 主管是其业务团队的 Lead，worker 之间允许同团队通信，不允许创建下级；不直接依赖官方 Agent Teams 服务。
- 新运行模式使用一个静态入口 `dsh-router`。动态角色变为版本化数据，不再动态注册角色 preset。
- 采用单一 SQLite 事务账本，第一版不维护第二种日志存储后端；缺少 `node:sqlite` 或可靠持久化能力时新协议拒绝激活，不能静默退回内存。
- 保留 Router 既有人工验收、问答、预算、熔断、紧急暂停、记忆、工作台能力；改变其数据来源而非删掉用户能力。
- 同一已有会话不混跑新旧运行模式。新任务在新会话启用新协议；旧会话有界兼容至结清。
- 自动创建角色默认限当前团队；用户可提升为项目/全局可用。模型不能借角色创建提升管理权限或安装代码。
- 正常报告是唯一默认成功路径；新模式不沿用“解析自由文本后系统代提交成功”的兜底。旧模式保留历史行为和来源标签。

### 1.3 不做什么

不替换 AgentLoop/AgentFactory，不重写模型请求或历史格式，不自建模型循环；不修改宿主；不实施跨主机团队；不承诺外部副作用 exactly-once；不把写范围声明当沙箱；不同时重构记忆算法；不自动卸载 Kernel、不改桌面 profile、不自动重启桌面。

## 2. 事实基线与为什么不能直接拼接

### 2.1 核对基线

- Router：`5c5ec91ad6a7e945ba355abf3b532b42f3791901`。独立文档 worktree 跑 `npm test`：59 文件、1109 测试通过。只证明现有测试基线，不证明本方案。
- Kernel：HEAD `c1ecc3340de04e0229df87b7e07a8d67cda95afe`，存在用户未提交的多任务/UI等改动。参考当前工作树与源码事实，不复制未提交文件、不清理 `.agent-kernel/`。
- 宿主：当前桌面安装包 `0.2.2-rc.1` 的实际导出；官方离线文档位于容器 `docs/official/`。系统 Node v24.18.1、桌面 Electron Node v24.21.0 均可读取 `node:sqlite.DatabaseSync`；这是能力探查，不是事务持久性验收。
- 官方工具包 `install/apply`：每个 Agent 的 `agent.ctx` 注册 `team:policy` section、必需身份 context、工具；处理已存在 Agent、创建和销毁。
- 官方 `TeamRoster.tryMembership`：普通宿主 subagent 不能直接成为官方 Team Lead。因此不能照搬“Router spawn主管，再让该主管调用官方 spawn_teammate”。
- 官方当前子会话入口是 `startActivation`；当前消息路径是宿主 steer/子代理消息通道，不能把历史调查中的 Lead 日志 mailbox 保证视为当前实现。

### 2.2 需纠正的既有实现缺口（静态审计，不等同已复现故障）

| 缺口 | 证据入口 | 新实现必须证明 |
|---|---|---|
| 创建返回后才绑定子身份，未传预留 childId | Kernel bridge/core 派发路径；Router attachSession | 首个模型步骤前身份已持久、恢复不会重复创建 |
| outbox 先消费再异步发，失败可能不重投 | Kernel `#pumpOutbox` | 确认持久接受后才标 accepted；消费与发送确认分开 |
| 日志压缩可能在应用当前事务前快照、无 fsync | Kernel store 的 `_persist/compact` | 不迁入此后端；SQLite事务与故障注入证明 |
| 镜像浅拷贝/返回活对象可能破坏回滚 | Kernel BaseStore 与 ledger 原地修改 | 事务外不可变读取、失败后内存/磁盘同版本 |
| 无 requiredChecks 的失败节点可能满足成功结束 | Kernel `deriveRun.successEligible` | 所有必需工作成功且检查通过才可 success |
| 写工具 required 含 commandId、properties 未定义 | Kernel tools | 每个工具schema按真实宿主编译，拒绝自相矛盾 |
| 结果读取未使用 caller，工具需求仅声明 | Kernel `resultRead`/definitions | 逐对象读写鉴权、工具可见性与最终执行双重约束 |
| complete 段由多处拥有 | Router persona/prompt-section，Kernel presets | 一个会话只有一个有效完整提示词所有者 |

只迁入协议思想、经过反例测试的算法与可复用界面逻辑；不将整个 Kernel 源码直接复制为“可靠内核”。

## 3. 整体架构

```text
用户
  ↓ 选择唯一 Router preset
Router 会话（需求澄清 / 多任务入口 / 总体验收 / 用户反馈）
  ├─ 项目任务 A → 主管 A（Team A Lead）
  │                 ├─ 成员：实现
  │                 ├─ 成员：测试
  │                 └─ 成员：审查 / 按需角色
  └─ 项目任务 B → 主管 B（Team B Lead）
                    └─ self 或多个受管成员

工具命令 / 用户界面命令
  → 身份与授权 → 命令幂等 + 版本检查
  → Router 任务内核（纯规则、执行图、结果与验收）
  → 唯一 SQLite 事务账本（状态、事件、派发意图、outbox）
  → 副作用驱动器 → DSH 会话 / 消息 / 中断 / 文档

事务提交 → 有序视图发布 → Session 投影 → 团队/任务图/文档/通知界面
```

### 3.1 三种关系分开

- 责任关系：Router 负责主管任务；主管负责其团队。依据持久 assignment，不能信任模型自填 parent。
- 执行关系：Task/Run/Graph/Attempt 表示工作依赖和执行尝试。共享成员可依次执行多个 attempt，不等于每个节点必有一个新会话。
- 宿主关系：DSH parentSession/子代理目录用于合法创建与控制。必须与已登记的责任关系对应，不伪造宿主父节点。

一个主管管理一项上级委派任务及其团队；同一 Router 可管理多个主管。第一版不复用主管会话跨项目任务，避免历史与授权串用。worker 可在同团队顺序领取工作，第一版每个成员最多一个活跃 attempt。

Router创建一项根任务时，内核同时建立根Run和一个必需的supervisor委派节点，主管领取对应子任务并在其下维护团队执行图；不能让模型用通用graph接口把根节点改成直接worker派发。主管的主动finish生成其上级委派节点的规范Result（source仍为该主管会话提交），根任务按配置验收后由Router主动finish并汇报。简单任务由主管创建self节点并自己提交该attempt结果，不需要假造worker。团队成员的claim是内核内部准入步骤，由主管dispatch命令触发，第一版不额外开放成员自助抢单工具。

### 3.2 模块边界

| 模块 | 职责 | 禁止 |
|---|---|---|
| domain | 类型、状态迁移、DAG、结果与验收、权限决策 | IO、宿主服务、模型调用 |
| store | SQLite事务、幂等回执、事件、索引、备份版本 | 自行调用模型/创建会话 |
| application | 以命令组织事务，计划副作用 | 在事务持锁期间等待宿主IO |
| runtime | 创建/恢复、提示词工具安装、消息、中断、对账 | 另建一套任务真相 |
| roles | 不可变定义、作用域、发布校验、模型配置 | 提升权限、任意代码、动态preset |
| safety | 预算、熔断、范围占用、停止屏障、提醒 | 在无报告时推断成功 |
| presentation | 读模型、Session投影、UI命令API | 通过轮询触发派发或修改状态 |
| legacy | 旧会话兼容、导入、协议版本分流 | 给同一任务双写新旧账本 |

## 4. 数据模型与唯一真源

### 4.1 核心对象

| 对象 | 核心内容与规则 |
|---|---|
| RouterBinding | sessionId、protocol=`legacy|v2`、project、modeGeneration；新建入口持久登记 |
| Task | id、rootRouter、parentTask、ownerAssignment、目标、验收策略、生命周期、当前revision/run |
| Revision | 不可变需求版本、brief、constraints、acceptance、文档引用/内容哈希；补充必须建新版本 |
| Run | 针对一个Revision的一轮执行；有自身图版本与停止epoch；返工产生新Run或新Attempt，不改旧结果 |
| GraphVersion | 不可变节点/边；expectedGraphVersion CAS；输入引用固定上游attempt/result |
| Node | `delegate|self|verify|join`、必需/可选、依赖、角色版本、writeScopes、requiredChecks |
| Attempt | 节点一次执行、执行者、roleVersion、输入快照、状态、stopEpoch、resultId |
| Team | 主管assignment、所属任务、成员上限、成员目录、teamRevision；与宿主官方Team无代码依赖 |
| Member/Assignment | 预留sessionId、parent、角色版本、权限快照、模型路由、生命周期、当前attempt |
| RoleDefinition | 不可变id/version、kind、instructions、工具需求、结果schema、模型偏好、可用范围、来源 |
| Result | attempt、revision、摘要、证据、产物引用、报告、结果状态、提交者、来源、内容哈希 |
| Acceptance | 针对精确result/attempt的auto/supervisor/user决定；谁、何时、依据、版本 |
| CommandReceipt | caller+commandId、规范化payloadHash、首次结果、关联事务序号 |
| DispatchIntent | 预留childId、创建阶段、首条消息id、宿主核对证据 |
| Outbox | deliveryId、目标、结构化业务事件、投递状态、尝试/错误/下次时间 |
| Event | 单调seq、schemaVersion、actor、root/task/team、因果commandId、变更事实 |
| ViewPublication | 目标session、viewRevision、sourceSeq、待发快照/确认；可重新生成 |

ID使用随机稳定ID；旧 `T-xxx` 保留 displayId/sourceId，不跨来源直接当主键。所有写命令有 `commandId`；同一主体同键同内容返回首次回执，同键换内容返回 `COMMAND_CONFLICT`。读取参数不允许借 callerSessionId 冒充主体。

### 4.2 事务存储决定

- 新存储路径 `<dataDir>/v2/router.sqlite`；默认dataDir沿用Router当前配置。
- SQLite `foreign_keys=ON`、`journal_mode=WAL`、`synchronous=FULL`、`busy_timeout=5000`；启动核对实际生效值和schema版本。
- 宿主进程内一个写队列、`BEGIN IMMEDIATE`。查询返回独立快照；事务失败不发布内存缓存、不发通知。
- 命令回执、领域状态、事件、派发意图/outbox在同一事务提交。
- 每个数据目录只允许一个副作用驱动所有者。用原子独占锁文件记录随机ownerToken、pid、主机标识与启动信息；活进程或无法证明死亡时第二实例只读，拒绝派发。不能仅以心跳过期偷锁；确认本机原进程已死并CAS核对锁内容后才能接管。
- 大报告正文/附件不进入事件和UI快照，只存授权引用、哈希和摘要；事件及回执至少保留至任务归档及迁移/备份策略允许清理，不任意TTL删除幂等回执。
- 数据库不可读/版本比程序新/完整性检查失败：进入诊断只读，不创建空库覆盖；提供备份与恢复指引。

### 4.3 文档与运行状态

文档不是调度真源。保留Router版本任务书和结果文档，按 `tasks/<taskId>/task.vN.md`、`runs/<runId>/…` 组织；界面可给当前版本别名，但不可覆盖历史版本。任务内容先入事务；文档物化作为可重试副作用，完成前不向成员投递只含一个不存在路径的任务。初始消息必须包含自足brief和验收要点，文档不可用时明确诊断。

收到报告可先保存结构化Result，再异步生成result.md；物化失败不丢结果，不假称文件已生成。恢复只能根据账本重建受管生成文档；用户手写文件冲突保留双方并告警，不静默覆盖。

## 5. 生命周期、图与验收

### 5.1 状态维度

不得把Agent是否running当作Task状态。分别维护：

- Task lifecycle：`open|closed`；closed outcome=`success|failure|cancelled`。
- Run：`active|pause_requested|paused|stop_requested|cancelled|uncertain|closed`。
- Node派生状态：`pending|ready|running|blocked|review_pending|succeeded|failed|cancelled|stale`。
- Attempt：`planned|provisioning|running|reported|accepted|rejected|failed|cancelled|uncertain`。
- Member创建：`provisioning|active|failed|retired`；运行态从宿主观察独立叠加。
- Delivery：`pending|in_flight|accepted|uncertain|dead_letter`，另记业务ack；accepted不等于模型处理完成。

不满足前置条件的操作返回结构化错误、当前版本及可行下一步。不得自动把失败升级为成功。

### 5.2 图管理

主管创建与维护本团队执行图；Router可以给主管任务追加验收要求或请求改图，但新增worker仍由主管派发。所有图更新走同一个CAS入口，与完成、停止、派发共用事务序列。

DAG拒绝自环、重复边、缺失引用和真实环，允许菱形；节点kind和输入输出契约必须校验。`verify`引用精确被验证attempt；上游返工使旧验证失效。`join`只表示汇合，不创建会话、不生成虚假工作结果。

图修改：尚未启动节点可修改；已运行节点需先停止并确认；已接受结果不重写。追加检查与结束并发时，只能一方以相应版本成功，另一方收到冲突，不能边结束边偷偷追加。

### 5.3 正常报告主线

1. worker调用报告工具提交 `status=success|failure|blocked`、摘要、报告与产物/证据引用。
2. 程序按真实assignment、attempt、revision、stopEpoch、结果schema校验，重复报告幂等。
3. `success`至少有非空摘要和一项非空证据引用或证据说明；纯调研可以引用结论依据，不强制产生文件。校验存在与归属不等于证明内容真实。
4. 配置requiredChecks时，由指定独立verify节点主动执行并报告。auto验收只表示协议与明确门禁通过，不是模型自动质量评判。
5. auto/supervisor/user分别推进：自动协议通过、上级主管/Router决定、用户明确确认。模型不能伪造user acceptance；已登录UI用户的决定通过受保护命令入口记录。
6. 所有必需工作成功、所有必需验收通过、没有运行/未知效果的尝试后，主管主动调用 `router_task_finish` 提交团队总结；Router再据此汇报或进入用户验收。

必需节点失败/取消/blocked不能success finish；可选节点只有在显式豁免并记理由后才不阻塞，不能静默把取消当通过。存在未完成必需子任务时不接受主管成功结束，返回缺失列表；可先保存草稿报告但不终结任务。

自然轮次结束、宿主subagent结果通知、关闭标签只改变观察状态。停滞提醒默认最多2次/attempt（跨重启保留），仍无报告则blocked并通知主管。waiting-user、仍有模型/工具请求在执行时不提醒；不得解析自由文本自动替它成功结算。

## 6. 唯一preset、身份和完整提示词

### 6.1 装配方式

- 唯一新入口preset id=`dsh-router`，用户显示名Router；静态声明替代运行时重复注册同ID。
- preset提供基础工具/压缩组合及一个“受管模式安装触发器”，不固定注册Router persona，不把所有子会话当主会话。
- 宿主根服务监听已有和新建/恢复Agent；每个Agent依据持久RouterBinding/Assignment安装一次。非受管会话不安装、不改变工具或提示。
- 新根会话：只有在入口模式明确且无父assignment时登记router；受管子会话找不到预登记身份时阻止首步，禁止降级为router或普通助手。
- scoped installer唯一拥有 `router:complete`，`complete:true`，文本由公共协议+授权角色版本+该角色职责构成。preset祖先不再提供另一份complete。继承链出现其他有效complete时明确失败并诊断，不能悄悄覆盖未知插件。
- 动态context=`router:identity`，`required:true`、`interpolate:false`；含当前身份、task/revision/run/attempt、上级、预算/停止事实与查询入口，不重复塞完整任务树。
- 卸载/Agent销毁逆序撤销注册；失败中途回滚；重新安装幂等；绑定事实不能来自历史角色卡、工具参数或模型自称。

### 6.2 spawn/fork

Router→主管默认spawn，完整brief，不继承长期Router历史。主管→worker允许fork以复用已完成轮次背景；没有可用completed prefix时明确记录降级为spawn，仍带完整任务材料。模型路由或后端不支持要求的fork/agentOptions时拒绝该派发或按已配置的明确候选顺序选路，不静默用不受管外部Agent。

所有层均复用同一基础preset组合；spawn可显式指定同一个`dsh-router`（只在provider声明支持时），fork不切preset。业务最多3层对应宿主根depth=0、主管=1、worker=2，须由真实宿主测试确认。

角色不同则complete文本不同，接受缓存复用减少，不为缓存把主管规则塞给worker。fork保留宿主允许的历史，不改写；当前身份明确覆盖旧身份的操作语义，但程序权限仍由当前assignment决定。宿主runtime context、项目规则、skills和工具结果等并不因complete而自动消失；只允许经过兼容审计的运行组合，不宣称控制模型的一切输入。

### 6.3 最终执行权限

可见工具不是授权。受管scope通过最终tool guard拦截所有绕过派发的入口（普通subagent/fork/workflow/delegate/第三方编排工具），未批准的不开放；即使模型猜出工具名也拒绝。工具限制继承和scope本地注册的实际行为必须集成验证。

Router有需求/主管管理权；主管只管理其team；worker只提交自己的attempt结果并读取授权材料。默认不给worker用户审批、全局角色发布、会话管理、安装插件、权限预设修改能力。文件系统仍由DSH审批/沙箱保护；Bash和外部进程无法靠writeScopes完整隔离，必须明确展示这一边界。

## 7. 角色管理与模型选择

### 7.1 定义与版本

`kind=supervisor|worker`是授权类别；测试、审查、研究、实现、Designer是专业定义，不是新权限层。Router角色由系统内置，不允许模型创建替代入口。定义不可变；编辑发布新version，已派发attempt固定旧version与hash，停用只阻止新派发，删除采用失效记录保历史可恢复。

scope=`team|project|global`。用户可管理有权访问的范围；Router可自动创建项目范围主管/worker定义；主管可在当前team创建worker定义；worker不能发布新权限角色，Designer只可对已授权request提交候选定义，由发布服务验证。主管需要新主管类型时向Router请求，不自行升级层级。

手动UI与模型工具共用publish服务。字段包括name、purpose、instructions、requestedTools、resultSchema、modelCandidates、来源、版本、scope；不接受JS/插件行/任意import。默认自动角色每team最多8个有效自建定义，单定义instructions最多16KiB，单次修复生成失败最多2次。超限明确拒绝，可由用户调整配置；不自动扩大预算。

有效权限=系统角色上限∩项目策略∩定义请求∩当前assignment授权；提示词不能改变此交集。公共协议部分不允许角色自定义覆盖；禁止“忽略公共规则”的意图不能靠字符串检查保证，真正边界仍靠执行校验。

### 7.2 模型配置

模型候选用结构化 `{provider,model}`，按角色版本/用户当前允许配置的确定顺序选择，记录最终路由、配置版本和能力探测结果。模型清单读取失败不是“所有模型可用”；此时阻止新派发并给出可恢复错误。

在创建前验证受管工具调用能力、持久会话、冷恢复和控制能力。已经发生业务副作用后不自动换模型重跑。用户更改角色模型设置只影响新attempt；在途换模型作为显式控制操作留痕，不能破坏身份/结果绑定。

## 8. 团队、消息、任务领取与等待

- 主管创建团队成员，先持久化provisioning和预留childId，再调用宿主启动；成员名team内唯一且不复用，失败保留记录。
- 可先建立一个待办节点，再创建并指派worker；成员领取必须满足依赖就绪、owner空闲、版本正确。领取与预算扣减同事务，竞争只允许一个成功。
- 创建成员和派发attempt是一条领域命令内计划、分阶段执行的过程，不允许模型绕开账本裸创建执行会话。
- Router↔主管、主管↔worker及同team worker↔worker可通信。跨team消息必须经过Router或显式授权的任务输入共享；消息本身不授予读写权限、不自动改变任务。
- peer消息使用业务mailbox、sender真实assignment与deliveryId。宿主只允许父子投递时，由主管合法relay；外层明确relay，正文保留原sender，绝不伪装宿主sender身份。不依赖官方内部私有消息helper；如公共通道不能安全relay则禁用peer发送并让主管转发，健康页显示能力缺口。
- 每条消息UTF-8最多64KiB，单目标pending最多128条、累计最多1MiB；超限返回背压，不丢旧消息、不唤醒风暴。
- target内按队列序号串行投递；peer普通消息、结果通知、停止事实分类处理，停止事实以权威guard为准，不能因普通队列顺序绕过。
- `wait`观察注册之后的新事件；先取当前游标、原子注册并检查可进展成员，消除检查与监听之间竞态。timeout范围10秒～1小时，无其他running/provisioning或可完成的投递工作则立即noProgress，不自动唤醒成员。wait结果不是完成结论。

## 9. 创建、投递、恢复与停止的健壮性

### 9.1 创建顺序

事务A：授权/CAS/依赖/预算/范围检查 → 生成attempt、预留childId、assignment(provisioning)、dispatchIntent → commit。

宿主操作：`startActivation({childId, …})`，agent/created读到已持久assignment、安装complete/context/tools/guard，才允许初始输入进入首步。

事务B：核对实际childId、父关系、模式、模型与消息接受凭证，记录active/initialAccepted。activation返回的messageId本身不冒充已flush证明；由适配器核对目标会话持久接受事实。

异常时保留intent并对账；不能删除provisioning后重新派同任务。无法判定宿主是否已创建/已执行时置uncertain并停止自动重建。

### 9.2 outbox与重复

业务结果与通知意图同事务。驱动领取delivery lease，再进行宿主投递；只有持久接受证据成立后才记accepted。ack表示接收方已对业务事件进行处理，另存，不提前consume。

允许“目标已收到、发送方尚未记账”后的至少一次重投。宿主消息去重必须对已处理后重启场景做测试；不能证明时不要盲重投会唤醒模型的消息，置uncertain并提供查询/人工重试。业务写命令和attempt领取必须幂等，即使模型重复读通知也不能重复创建执行。

重试只对明确可重试错误：退避1s、5s、30s、120s、600s（最多5次），之后dead_letter；权限/版本/能力缺失不重试，进入blocked或配置修复。lease重启后可重新领取，但先对账；不能并发两个泵处理同一目标。

### 9.3 崩溃窗口验收表

| 崩溃位置 | 恢复行为 |
|---|---|
| 事务A前 | 无创建，无预算扣减 |
| intent已提交、尚未创建 | 根据预留childId查询；确认不存在后创建同一ID |
| child创建、事务B未提交 | 核对子描述符、parent、assignment与初始消息，补账；不另开child |
| 初始消息可能已入队 | 查持久接受事实；不能确认则uncertain |
| 结果提交成功、通知未发 | 重放outbox，不重复结果/验收/解锁 |
| 通知接受、accepted未写 | 对账去重或uncertain，不宣称exactly-once |
| 工具外部效果发生、结果未写 | attempt uncertain，阻止同资源重派，先核实实际效果 |
| 文档写入或快照发布失败 | 重试物化，不撤回已提交业务事实 |
| 停止意图已写、尚未interrupt | 恢复优先恢复停止屏障，再请求中断 |

### 9.4 停止与暂停

- 取消task：先持久stopEpoch和stop_requested，冻结派发/业务副作用，再逐成员interrupt，观察收敛。interrupt返回不等于已停。
- 未确认停止不释放写资源，不转为可重试；超过60秒置uncertain、保留停止意图和诊断。
- 迟到报告可记录为历史观察，但不能结算或解锁；旧attempt永远不恢复有效。显式继续创建新attempt/run。
- 保留现有“当前Router范围紧急暂停”的快照语义：只选调用瞬间该Router现有活动派发树，先冻结这些run再interrupt；不全局冻结、不影响其他Router、之后新任务也不自动禁止。UI明确提示覆盖范围；用户要停后续新派发另用“暂停该Router接单/派发”独立控制。
- 全局熔断与范围暂停分开。解除熔断只允许用户，解除不等于自动恢复所有停止任务。
- HMR/卸载：先关闭准入、取消后台驱动并等待有界收敛；仍有任务时主动停用插件不能假称安全继续，保存停机事实，下一次先对账。所有异步事件/定时器统一catch，失效ctx不再读取必需服务；无unhandledRejection。

### 9.5 预算与资源

保留Router既有默认：每用户轮最多1个新主管任务、1批用户澄清；每任务最多2批澄清；连续3次主管派发失败冻结该主管；infra 10分钟内≥3次或创建≥10且零完成触发全局熔断。新增每team同时active/provisioning成员上限8，每team活动图节点上限256，每member同时执行1个attempt。设置放在单一policy配置，UI与模型上下文同源；调整需用户授权，不能由自动角色生成修改。

预算扣减在准入事务中；重试同commandId不重复计数。明确失败可有限重试，效果未知不重派。生产代码使用clock注入便于验证窗口与重启。

写范围按真实workspace/repo+规范化目录组件比较，处理大小写卷、符号链接和路径穿越；不能只字符串startsWith。对声明的重叠写范围，准入层串行化或要求不同worktree，持有者uncertain时不自动释放。未声明/外部进程写入仍由宿主沙箱与开发纪律约束，不宣称全面文件锁。

## 10. UI、投影与可观察性

### 10.1 界面职责

保留Router工作台、问答与交付通知，增加：主管团队视图（成员/工作分配）、版本化执行图、文档与结果、角色管理、健康/待核实操作。Router视图聚合多个任务；主管视图只展示其team；worker只见授权任务与团队摘要。点击成员打开真实宿主session，创建任务不抢焦点，关标签不取消；hidden subagent不伪造为原生左侧普通会话。

角色界面支持手动创建/编辑发布/停用/提升范围；显示模型生成来源、版本、权限请求和实际授予差异。运行中定义不被静默替换。

问答桥继续使用宿主原生提问能力：worker向主管请求澄清，主管能回答则直接答，需要用户决定时经Router汇聚成一批。问题记录保存task/attempt/epoch和宿主questionId，waiting-user与运行状态分开；重启后核对原生待答实例，失效问题标expired并允许重新发起，不能伪造回答或自动视为同意。用户未答/跳过不算授权。

保留搜索历史、项目/全局记忆与可选任务摘要压缩。只把已接受结果写入成功记忆；failure/blocked可以作为明确标注的事实保留，不冒充成功。记忆写入使用resultId幂等、失败仅重试记忆副作用，不重复结果结算；检索按workspace/task权限过滤。压缩读取统一任务快照，不扫描另一套legacy账本，也不把记忆当协议依据。

### 10.2 从轮询迁向宿主投影

SQLite仍是业务真源。每次事务产生可合并的ViewPublication；发布器按目标Session串行追加带schemaVersion、viewRevision、sourceSeq的 `router/view` 派生快照事件，flush后确认发布。投影只折叠这些事件，不在apply中查数据库或做IO；重复revision忽略，旧版本不覆盖新视图，非法快照保留最后有效值并显示failure。

此Session事件是可重建的界面缓存，不是第二个可写业务账本。SQLite领先Session时UI显示sourceSeq/更新时间，所有写命令仍到内核并检查当前版本。发布滞后不得让业务事务失败或卡住结果提交。

root快照只放任务摘要/计数/最近100条；team快照只放成员/节点摘要。单次快照上限256KiB，超出按稳定游标分页通过只读API查询；不截断正在等待用户处理的数量提示。报告正文、敏感消息、绝对路径按授权按需读取，不能把worker不可读内容推到它的session投影。无变化复用view引用，不发frame。

客户端首选Session store，禁止2.5秒全局轮询和读取时收编。首次加载/重连可用受限API核对并分页；冷session刷新只处理已知绑定、有限批次，不全盘扫描聊天记录。

### 10.3 HTTP与用户授权

沿用Router前缀，新增 `/router/v2/...`；查询和控制分开。接口先走宿主登录准入，再按可访问workspace/task/team做对象授权；POST校验Origin/宿主已有请求防护能力，拒绝跨站写入。HTTP主体不能从body的sessionId当作模型主体；用户验收记真实用户操作来源，模型工具不暴露等价user authority。

### 10.4 健康与审计

`/router/health`保留并扩展：协议版本、db/schema/完整性、驱动锁所有者、宿主能力矩阵、scoped安装数/失败原因、缺失complete或guard、恢复队列、pending/uncertain/dead_letter、最老outbox年龄、投影lag、预算/熔断、停止未收敛数。不得输出token或完整敏感消息。

每个命令带correlationId，事件记录actor/原因/前后版本；read不产生业务副作用。启动必须自报“启用v2/仅兼容/只读降级”及原因，不能沉默地看似成功。

## 11. 迁移与兼容

### 11.1 发布顺序

先作为feature flag默认关闭的v2实现，现有Router保持可用；在独立web profile上验证后逐步启用新会话。旧会话的protocol判定持久化，不能因升级默认值变化自动改身份。

旧preset ID `dsh-router-executor`、`dsh-router-supervisor`、`dsh-router-worker` 和已有动态类型ID按持久清单保兼容解析，不继续给新角色创建preset。宿主若无隐藏preset能力，过渡期这些兼容入口仍可能显示：名称标明旧会话兼容、排序后置，不能承诺选择器物理上立即只剩一行。最终一个正式新建入口，其余为可移除的历史兼容。

同一个 `dsh-router` id 从动态注册迁至静态时，必须先取消旧动态所有者，避免重复ID；已有根会话通过绑定/旧索引区分legacy，新会话才v2。不能让一个现有legacy根会话在同一轮兼用两套工具。

### 11.2 数据导入

只读读取旧ledger、worker-types、defaults、prompt overrides、questions、notifications、guard-state及会话索引；先生成dry-run报告、源hash和逐记录映射。导入到新数据库事务，使用 `sourceSystem+sourceId+sourceVersion` 幂等键。完整保留原状态/结果来源/文档路径，不把system-judged旧结果改标为会话主动提交。

终态任务可导入为只读历史；活动任务默认留legacy结清。用户显式迁移活动任务时必须先暂停、确认宿主无运行/未知效果、保存备份、绑定旧session/身份，再切单一写入者；未知归属保留为待核实，不能猜责任关系。

Kernel数据不自动读取/接管。提供单独dry-run导入器，用户指定来源与范围后才能导入；已完成任务/角色先行，活动任务需停止交接。不修改Kernel代码或存储，不因安装Router就关闭Kernel。相同session同时被Kernel与Router声明时拒绝绑定并显示冲突。

### 11.3 回退

升级前做SQLite一致性备份（不能只复制活跃WAL数据库主文件）、旧文件快照、源hash与版本清单。v2启动后旧文件只读，禁止双写。

v2产生新任务后不能让旧程序写v2数据：先停止并核实v2任务，保存一致性备份，旧程序仅恢复旧模式；v2新数据保留可导出，不能静默丢弃或反向硬映射。回退演练必须含“已有v2任务和未投递通知”的场景。

## 12. 代码组织与旧模块处置

在Router内部新增 `src/host/v2/` 分域模块、`src/shared/v2/` 协议类型和独立 `tests/v2/`；使用TypeScript沿用现有构建。入口只装配，不继续扩大现有core/entry巨型函数。

| 既有部分 | 处置 |
|---|---|
| ledger/machine/scheduler/core | legacy分流保留；新任务只走v2内核，逐步退役 |
| bridge/sessions | 新v2只有一个宿主adapter，不复刻手工会话创建链；旧路径仅兼容 |
| presets/dynamic/lifecycle | 停止新角色动态注册；保兼容ID/旧配置读取 |
| prompt-section/context/prompts | 旧会话保留；新安装器拥有唯一complete与精简身份context |
| tools | 新名统一router_前缀；旧工具只在legacy scope，避免覆盖官方同名工具 |
| guard | 复用预算/熔断/暂停产品语义，存储进入统一事务；旧判定器不接管v2结果 |
| questions/notifications | UI复用，写操作转统一命令；可靠通知由outbox驱动 |
| memory/compaction | 保留可选能力，输入来自已接受结果/任务摘要，非任务真源；不复制新存储 |
| session index | 兼容旧收编；v2持久binding查询，不全盘扫描 |
| client | 逐步从轮询store转Session投影与分页；保持原生导航和未安装其他插件可用 |

删除/改名之前必须全仓搜索package exports、patch、测试、文档及profile引用，兼容ID不能先删后查。

## 13. 验收与交付标准

### 13.1 必须通过的端到端场景

A. 只安装Router，一个正式入口preset；创建两个根会话互不串任务，普通模式不受影响。
B. Router派两个主管，各组独立团队；主管self简单任务与成员并行任务都能主动报告闭环。
C. 手动角色、主管自动worker角色、Router自动主管角色均可发布与使用；越权定义拒绝；在途版本不变。
D. 首步身份/工具/complete正确，fork不继承父权限；压缩、冷恢复、HMR后依然一致。
E. DAG菱形、验收依赖、返工旧验证失效、失败不得成功结束、user验收不能模型冒充。
F. 创建与投递每个崩溃窗口可对账；未知效果不重复创建/执行；重复报告/通知不重复结算。
G. 停止、迟到结果、熔断和恢复、跨Router紧急暂停范围准确；等待用户不自动催促。
H. Session投影断线/滞后/坏事件/分页可恢复；UI读取不产生派发；worker看不到别的team详情。
I. 旧根/执行者/动态preset会话能恢复；导入dry-run/重复导入/回退不丢事实。
J. 无inactive-context异常、无unhandled rejection；降级时健康与界面可见，不静默失败。

### 13.2 质量门禁

实现每阶段：`npm run typecheck`、`npm test`、`npm run build`；声明行变更跑双宿主 `check-host-rows.mjs dsh-router`、动态兼容行检查；client变更重建后跑 `check-client-activation.mjs dsh-router`。补充独立profile真实宿主测试（版本/Node/模型/能力/结果留证）。无测试密钥入库。

注意当前Vitest只include `tests/**/*.spec.ts`，已有`.spec.tsx`不会自动执行；新增UI测试采用`.spec.ts`或显式修正include并证明被发现。不得以“测试全绿”掩盖未收集的测试。

只有通过独立web实例的真实装载/三层执行/恢复/停止演练，才可切桌面。桌面退出重开由用户操作；合并后构建产物更新，不因源码合并就宣布生效。

## 14. 阶段与批准点

1. P0：宿主契约与失败反例测试；验证一个preset与预登记身份可行。
2. P1：事务存储、纯协议与报告/验收，禁止未完成阶段触发真实派发。
3. P2：角色、身份/提示词/权限与单一宿主桥；先串行闭环。
4. P3：团队消息、可靠outbox、停止恢复与防护；再并行。
5. P4：读模型/界面、兼容迁移；保旧产品入口可用。
6. P5：集成故障注入、独立web实测、用户验收、受控切换。

每阶段可独立测试和拒收。P0能力不成立时停止后续依赖任务并报告，不绕过宿主契约。用户批准本设计及配套实施计划后，才创建执行团队；验收不通过不合主干、不动桌面部署。
