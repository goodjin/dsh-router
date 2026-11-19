> **归档说明（2026-11-19）**：本文出自已废弃的 router-team-v2 候选线（2026-11-13~15，未合入主干，代码与分支已清理）。
> 其设计已被《2026-11-16 Router 轻量协作设计》（本仓现行主线）取代。归档仅作教训清单与崩溃窗口对账思路的参考；
> 文内所有状态自述与日期均已过期，不得当作现状或能力证据。

# Router 团队化升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 用户已选择智能体团队执行。本文和设计均为待审阅交付，未批准前不得开始产品代码。执行团队的组织与权限见同目录 `2026-11-14-router-team-execution-handoff.md`。

**Goal:** 在 Router 内实现“Router接任务→主管组队→成员主动报告”的统一任务体系，吸收 Kernel 协议并取消每角色preset。

**Architecture:** 一个入口preset与逐Agent身份装配；Router内部单一SQLite事务内核负责任务、图、成员、结果与outbox。宿主只承担会话运行与受控工具执行；Session投影为可重建读模型；旧会话按协议版本隔离运行。

**Tech Stack:** TypeScript、Node `node:sqlite`、DSH Cordis/session/subagents/systemPrompt/tools、React、Vitest，沿用Router构建。

**Spec:** `../specs/2026-11-14-router-team-upgrade-design.md`

## Global Constraints

- 产品包名保持 `@goodjin2/dsh-router`；新入口preset id=`dsh-router`；新模型工具名统一 `router_` 前缀。
- 新实现仅修改Router独立worktree，不修改Kernel仓库、官方文档、运行中的desktop profile，不自动重启桌面。
- 新协议业务深度固定3层：Router→supervisor→worker；根宿主depth=0，成员最大depth=2。主管禁止派主管，worker禁止任何形式派发。
- 每Agent一个有效 `router:complete`，`complete:true`；身份context `router:identity`、`required:true`、`interpolate:false`。
- 新账本唯一路径 `<dataDir>/v2/router.sqlite`；SQLite foreign_keys=ON、journal_mode=WAL、synchronous=FULL、busy_timeout=5000；无日志/内存持久化兜底。
- 每team最多8个active/provisioning成员、256个活动图节点；每member同时1个attempt；自动team角色最多8个、instructions最多16KiB、生成修复最多2次。
- 消息最多64KiB UTF-8；单target pending最多128条且累计1MiB；wait为10秒～1小时。
- outbox重试退避1s/5s/30s/120s/600s，最多5次；停止60秒未确认→uncertain；提醒最多2次/attempt。
- 保留既有Router默认预算：每用户轮1个新主管任务/1批澄清，每任务2批澄清，主管连续3次派发失败冻结；infra 10分钟≥3或创建≥10且零完成熔断。
- UI快照256KiB上限、根列表最近100条加游标；不把report正文放快照；UI读取零业务副作用。
- 所有修改分支必须typecheck/test/build全绿再合；声明行双宿主检查，client构建后激活预检，真实web验证，最后由用户重开桌面。
- 不宣称exactly-once、不把空闲当成功、不把writeScopes当沙箱、不将静态源码审计冒充实机验证。

## Review Focus

1. 首轮、fork及冷恢复在assignment绑定前启动：必须首步拒绝缺失身份，不把子会话当Router（T01/T06/T07）。
2. 停止与成功报告、追加检查与finish同时到达：只能按事务顺序一个成功，旧epoch/graphVersion结果不能解锁（T04/T10）。
3. 宿主已创建或接收消息但插件未记账即崩溃：不重复child、不先标已投递；不确定时停在uncertain（T07/T09）。
4. UI或模型伪造sessionId、跨团队resultId、user验收、未知工具：读写同样鉴权；完整提示词不是权限边界（T05/T06/T12）。
5. 迁移源缺归属、数据库损坏、旧preset被删、fork无descriptor、第二宿主抢驱动：不猜、不另开空真源、不自动执行（T02/T13/T15）。

---

## 0. 执行准备与依赖图

基线Router `5c5ec91ad6a7e945ba355abf3b532b42f3791901`；Kernel HEAD `c1ecc3340de04e0229df87b7e07a8d67cda95afe`且有未提交修改，只作参考。启动前再次记录两者状态；若源变动，更新迁入清单和影响审查，不覆盖用户改动。

建议集成分支 `feature/router-team-v2`；成员独立worktree `.worktrees/router-v2-<scope>`。本次文档分支可作为已审阅设计来源；不在文档分支直接开始产品修改。

依赖：T01→T02→T03；T03之后T04、T05可并行；T05+T01→T06；T03+T06→T07；T04+T05+T07→T08；T07→T09；T04+T08+T09→T10；T03+T04+T09→T11；T05+T08+T10+T11→T12；T02+T04+T06→T13；T12+T13→T14；所有→T15。T01不通过时不得进行依赖真实宿主的接线。

## 1. 目录与接口所有权

| 目录/入口 | 责任 | 所有者 |
|---|---|---|
| `src/shared/v2/` | 公开协议、命令、结果、视图类型 | Lead/契约负责人 |
| `src/host/v2/domain/` | 纯图、状态、权限规则 | 协议负责人 |
| `src/host/v2/store/` | schema、事务、幂等、锁、备份 | 存储负责人 |
| `src/host/v2/application/` | 命令服务、事务编排 | 协议负责人；改公共服务接口须Lead批准 |
| `src/host/v2/runtime/` | 宿主适配、安装器、创建、投递、恢复 | 运行时负责人 |
| `src/host/v2/roles/` | 版本化角色与模型选择 | 角色负责人 |
| `src/host/v2/safety/` | 预算、停止、范围、提醒 | 健壮性负责人 |
| `src/host/v2/presentation/` | 投影发布、查询/API | 接口负责人 |
| `src/host/v2/migration/` | 导入、legacy绑定、备份回退 | 迁移负责人 |
| `src/client/v2/` | 视图/角色/健康/命令交互 | UI负责人 |
| `src/entry.ts`、`cordis.patch.yml`、`package.json`、公共构建 | 总装/兼容/产物 | 仅集成人员 |
| `tests/v2/`、`scripts/v2/` | 各模块测试/独立宿主验收 | 对应模块；最终验收独立负责人 |

新增生产文件按上表拆分，不新增第二个巨型core；一个模块不得直接修改别的模块底层表。所有新增测试命名 `.spec.ts`（JSX可用React.createElement），除非T01明确修正Vitest include；不能写了`.spec.tsx`却未被测试发现。

## 2. 公共契约（T03冻结，后续任务引用，不自行改名）

### 2.1 基础类型

在 `src/shared/v2/types.ts` 定义以下类型（字符串ID采用独立type alias，不要求运行时brand）：

- `Id = string`，`Seq = number`，`RoleKind = 'router'|'supervisor'|'worker'`，`Protocol = 'legacy'|'v2'`。
- `RoleRef = {id: Id; version: number}`；`ModelRef = {provider: string; model: string}`。
- `Actor = {kind:'agent'; sessionId:Id} | {kind:'user'; principalId:string; allowedWorkspaceIds:readonly Id[]}`。Actor只能由工具exec/HTTP登录适配器创建，不能来自模型参数。
- `CommandMeta = {commandId:Id; actor:Actor; correlationId:Id}`。
- `ProtocolError = {code:ErrorCode; message:string; retryable:boolean; currentVersion?:number; details?:Record<string,unknown>}`。
- `Reply<T> = {ok:true; value:T; replayed:boolean; seq:Seq} | {ok:false; error:ProtocolError}`。
- `ErrorCode`固定：`INVALID_ARGUMENT|FORBIDDEN|NOT_FOUND|STALE_VERSION|COMMAND_CONFLICT|NOT_READY|BUDGET_EXCEEDED|RESOURCE_BUSY|STOPPED|UNCERTAIN|CAPABILITY_MISSING|PERSISTENCE_FAILED|CORRUPT_STATE|BACKPRESSURE|CONFLICTING_OWNER`。
- `Assignment = {id; sessionId; parentSessionId?; rootRouterSessionId; taskId?; teamId?; role:RoleKind; roleRef:RoleRef; promptHash:string; state:'provisioning'|'active'|'failed'|'retired'; currentAttemptId?:Id; grantedTools:readonly string[]; model:ModelRef; workspaceId:Id; cwd:string; epoch:number}`。
- `ResultInput = {attemptId; expectedRevision:number; expectedEpoch:number; status:'success'|'failure'|'blocked'; summary:string; evidence:readonly string[]; artifacts:readonly string[]; reportRef?:string; blockers?:readonly string[]}`。
- `NodeInput = {id; kind:'delegate'|'self'|'verify'|'join'; title:string; brief:string; required:boolean; dependsOn:readonly Id[]; roleRef?:RoleRef; context:'fresh'|'fork'; inputs:readonly {nodeId:Id; resultId:Id}[]; writeScopes:readonly string[]; requiredChecks:readonly Id[]; targetNodes:readonly Id[]}`。kind专属字段严格校验；join禁止roleRef，verify必须有targetNodes。
- `GraphInput = {taskId; expectedGraphVersion:number; mode:'create'|'append'|'replace'; nodes:readonly NodeInput[]; reason:string}`。
- `RoleDraft = {id; name:string; kind:'supervisor'|'worker'; purpose:string; instructions:string; requestedTools:readonly string[]; resultSchema:Record<string,unknown>; modelCandidates:readonly ModelRef[]; scope:{kind:'team'|'project'|'global'; id:Id}; source:'user'|'model'; generationRequestId?:Id}`。source由服务根据Actor填写，忽略外部自报。

实体行除上述业务字段均有`schemaVersion/createdAt/updatedAt/revision`；具体表字段由T02 schema定义并在T03补齐引用，不使用`any`跨边界。

### 2.2 Store与运行适配接口

`src/host/v2/store/types.ts`：

- `openRouterStore(options:{path:string; owner:DriverOwner; readOnly?:boolean}): Promise<RouterStore>`。
- `RouterStore.read<T>(query:(view:ReadView)=>T): T`，返回值深复制/只读；`transact<T>(operation:(tx:WriteTx)=>T): Promise<{value:T;seq:Seq}>`，回调同步，不能返回Promise；`close():Promise<void>`，`backup(path:string):Promise<BackupManifest>`。
- `ReadView.get<K extends Table>(table:K,id:Id):Readonly<RowMap[K]>|undefined`；`scan<K>(table:K,query:ScanQuery):readonly Readonly<RowMap[K]>[]`；`events(after:Seq,limit:number):readonly DomainEvent[]`；`lastSeq():Seq`。
- `WriteTx`扩展ReadView，增加 `put<K>(table:K,row:RowMap[K]):void`、`append(event:NewDomainEvent):void`；软删除用记录状态，不提供无审计的通用delete。
- `executeCommand<T>(store:RouterStore,meta:CommandMeta,payload:JsonValue,authorizeCurrent:(view:ReadView)=>void,apply:(tx:WriteTx)=>T):Promise<Reply<T>>`。幂等key含Actor身份；规范化payload hash需包含操作类型与所有影响结果字段。authorizeCurrent必须同步、无副作用，在同一事务的receipt/conflict/replay之前检查当前身份及对象可见性；apply仅首次执行业务/CAS/预算。

`src/host/v2/runtime/host-port.ts`：

- `HostPort.capabilities():Promise<HostCapabilities>`；能力结构至少包含reservedChildId、scopedComplete、requiredContext、finalToolGuard、durableMessageEvidence、coldResume、spawn、fork、sqlite、projection。
- `start(spec:{childId; parentSessionId; mode:'fresh'|'fork'; presetId:'dsh-router'; prompt:string; model:ModelRef; cwd:string; maxDepth:2; signal:AbortSignal}):Promise<{childId;messageId?:Id}>`。
- `inspectChild(childId:Id):Promise<ChildEvidence>`，`ChildEvidence`是 `absent|matched|mismatch|unknown` 判别联合；matched包含parent、descriptor、初始消息持久接受证据。
- `deliver(spec:{deliveryId;senderSessionId;targetSessionId;relayBySessionId?:Id;content:string;signal:AbortSignal}):Promise<DeliveryEvidence>`，证据是`accepted|unknown|rejected`联合，accepted必须包含durable=true及messageId。
- `interrupt(sessionId:Id,reason:string):Promise<void>`；`observe(sessionId:Id):Promise<{status:'running'|'inactive'|'unknown';pendingInput:boolean;pendingTool:boolean}>`。
- `publishView(sessionId:Id,event:ViewEvent):Promise<{durable:true}>`；`onActivity(listener:(event:HostActivity)=>void):()=>void`。

HostPort是内部适配接口，不声称DSH存在同名方法。具体宿主调用以T01实测为准；缺少能力返回typed error，不能猜方法或使用私有internal导出。

### 2.3 统一命令服务与工具名

`RouterV2.execute(meta:CommandMeta, command:RouterCommand):Promise<Reply<CommandValue>>`；`query(actor:Actor,query:RouterQuery):Promise<Reply<QueryValue>>`；`close():Promise<void>`。RouterCommand/RouterQuery为显式判别联合，各工具一一映射，不接受任意action字符串。

| 工具名 | command/query kind | 参数（不含可信Actor；写入一律有commandId） |
|---|---|---|
| router_task_create | task.create | title, brief, workspaceId, acceptancePolicy, supervisorRoleRef |
| router_task_revise | task.revise | taskId, expectedRevision, brief, reason |
| router_graph_set | graph.set | GraphInput |
| router_dispatch | graph.dispatch | taskId, expectedGraphVersion, nodeIds |
| router_team_list | team.list | taskId |
| router_team_message | team.message | teamId, targetMemberId, content |
| router_team_wait | team.wait | teamId, afterSeq, timeoutMs |
| router_role_list | role.list | scope, purpose? |
| router_role_publish | role.publish | expectedVersion, definition:RoleDraft |
| router_report_progress | attempt.progress | attemptId, expectedEpoch, summary |
| router_result_submit | result.submit | ResultInput |
| router_result_read | result.read | resultId |
| router_task_finish | task.finish | taskId, expectedRevision, expectedGraphVersion, outcome, summary |
| router_task_accept | task.accept | taskId, resultId, expectedRevision, decision, reason |
| router_task_control | task.control | taskId, expectedRevision, action:'pause'|'stop'|'resume'|'retry', reason, attemptId? |
| router_state_get | state.get | taskId?, teamId?, cursor?, limit? |
| router_search_history | history.search | query, workspaceId, cursor?, limit? |

`task.create`仅Router创建根Task、根Run和一个必需supervisor委派节点，同时计划主管子任务及其Team；该命令的单次新主管派发计入Router预算，不再要求Router另发graph.dispatch。主管主动finish转为上级委派节点的规范Result；根验收后Router主动finish。`graph.dispatch`主管为delegate/verify节点创建或指派member，self不建成员；claimNode是此命令内部的原子准入步骤，不是第一版额外模型工具。`team.list`只读；无裸spawn工具。Designer调用role.publish只提交已授权request候选，不允许自发发布管理角色。user验收、解除熔断、提升全局角色只走用户命令入口，不等价暴露给模型。

详细命令字段的可选/必填按表和设计执行；schema.properties必须包含commandId且所有required均存在；未知属性拒绝；所有读命令也按Actor限定可见对象。

---

## Task 1: T01 / P0：宿主契约探针与新协议隔离开关

**Files:** Create `src/host/v2/runtime/capabilities.ts`, `tests/v2/host-contract.spec.ts`, `scripts/v2/probe-host.mjs`, `docs/research/2026-11-14-router-v2-host-contract.md`; Modify `vitest.config.ts` only if adding TSX discovery; no desktop/profile changes.

**Interfaces:** Produces `probeCapabilities(host:HostProbe):Promise<HostCapabilities>`；HostProbe只读测试面由本任务定义在capabilities模块，真实探针与fake共用结果shape。报告包含hostVersion/nodeVersion/probeVersion以及每能力pass/fail/untested。

- [ ] **Step 1 — 失败测试**：写 `missing_reserved_child_is_rejected`、`child_identity_precedes_first_step`、`one_complete_per_scope`、`fork_has_no_current_turn`、`unknown_capability_is_not_true`；未运行的真实项必须untested。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/host-contract.spec.ts`；断言失败/模块缺失，不接受环境错误冒充红灯。
- [ ] **Step 3 — 实现**：核对真实安装包公开接口；探针只在独立DSH_HOME/profile执行，先验证父子两层冷恢复、guard时序、childId、accepted证据与同preset完整提示词。不能证明的能力使v2运行禁用。将旧README/源码差异记入报告，不改官方镜像。
- [ ] **Step 4 — 绿灯及人工证据**：同命令PASS；`node scripts/v2/probe-host.mjs --help`解释临时profile参数，报告模板不能假填pass。独立实例实际运行后记录证据；P0未绿则停止T06/T07接线。
- [ ] **Step 5 — 提交**：只stage上述文件，`git commit -m "test(router-v2): pin host lifecycle and capability contracts"`。

## Task 2: T02 / P1：SQLite真源、事务隔离与单驱动锁

**Files:** Create `src/host/v2/store/{types,schema,sqlite,owner-lock,backup}.ts`, `tests/v2/{store,owner-lock,backup}.spec.ts`。

**Interfaces:** Produces第2.2节Store接口；`DriverOwner={token:string;pid:number;hostId:string;startedAt:number}`；`BackupManifest={schemaVersion:number;seq:Seq;sourceHash:string;backupPath:string;createdAt:number}`。RowMap表包括bindings/tasks/revisions/runs/graphs/nodes/attempts/teams/assignments/roles/results/acceptances/commands/dispatchIntents/outbox/events/viewPublications/budgets/resourceClaims/migrations。

- [ ] **Step 1 — 失败测试**：
  ```ts
  it('failed_commit_keeps_old_snapshot', async () => {
    const h = await storeHarness(); await h.seedTask('t', 'old');
    h.failNextCommit(); await expect(h.renameTask('t', 'new')).rejects.toThrow();
    expect(h.readTitle('t')).toBe('old'); expect(await h.reopenTitle('t')).toBe('old');
  });
  ```
  同文件定义storeHarness（临时目录、真实sqlite、可注入commit失败，不用生产数据）。另测returned_object_cannot_mutate_store、wrong_schema_readonly、corrupt_db_never_falls_back、second_live_owner_cannot_dispatch、backup_includes_wal_commits。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/store.spec.ts tests/v2/owner-lock.spec.ts tests/v2/backup.spec.ts`。
- [ ] **Step 3 — 实现**：事务内write-set/深复制防原地泄漏，SQLite错误保持原库；第二owner只读；主机未知/进程无法确认死不抢锁。backup使用SQLite一致性备份能力并校验manifest，不复制活跃主文件了事。
- [ ] **Step 4 — 绿灯**：同测试PASS；子进程故障注入在commit前/后退出，重开数据只可能前态或后态，不半态；记录SQLite pragmas实际值。
- [ ] **Step 5 — 提交**：`git commit -m "feat(router-v2): add durable transactional store and driver ownership"`（只stage本任务文件）。

## Task 3: T03 / P1：冻结协议类型、幂等命令与读取授权

**Files:** Create `src/shared/v2/{types,commands,views}.ts`, `src/host/v2/application/{commands,query,service}.ts`, `src/host/v2/domain/{errors,authorization}.ts`, `tests/v2/{command-idempotency,authorization}.spec.ts`。

**Interfaces:** ConsumesStore；Produces第2.1/2.3节类型、RouterV2外观、`authorize(actor,action,resource,view):void`、`executeCommand`。未实现命令显式CAPABILITY_MISSING，禁止空成功。

- [ ] **Step 1 — 失败测试**：同Actor同key同payload返回首次seq/value且replayed；换payload→COMMAND_CONFLICT；另Actor同key不相互泄漏；result.read跨team拒绝；伪造body.actor无效；self修改权限拒绝。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/command-idempotency.spec.ts tests/v2/authorization.spec.ts`。
- [ ] **Step 3 — 实现**：payload规范化hash含kind、task/revision/epoch；查询进行对象授权和分页上限（limit默认50、最大100）；Actor适配器外不能构造user权力。命令失败也保留可解释错误，不把未知catch吞成ok。
- [ ] **Step 4 — 绿灯**：上述PASS + `npm run typecheck`；Lead审阅公共类型后锁定，后续变更作为契约变更走消息和review。
- [ ] **Step 5 — 提交**：`git commit -m "feat(router-v2): establish command contracts and object authorization"`。

## Task 4: T04 / P1：任务/版本/执行图/报告与验收

**Files:** Create `src/host/v2/domain/{task,graph,attempt,result,acceptance}.ts`, `src/host/v2/application/{tasks,graphs,results}.ts`, `tests/v2/{task-graph,result-acceptance}.spec.ts`。

**Interfaces:** ConsumesRouterV2/store；Produces `validateGraph(nodes:readonly NodeInput[]):ValidatedGraph`、`deriveRun(snapshot:RunSnapshot):RunView`，以及task.create/revise、graph.set、result.submit/read、task.finish/accept命令处理。RunSnapshot和RunView在shared/views公开。

- [ ] **Step 1 — 失败测试**：
  ```ts
  it('failed_required_attempt_never_allows_success', () => {
    const run = failedRequiredSelfRun(); // 本文件构造一必需self节点+failure结果
    expect(deriveRun(run).successEligible).toBe(false);
  });
  ```
  另测diamond_valid/cycle_rejected、stale_graph_cas、old_revision_report、report_missing_evidence、duplicate_result、verify_invalidated_by_retry、optional_skip_requires_explicit_waiver、user_accept_not_agent、append_check_races_finish_only_one_commits。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/task-graph.spec.ts tests/v2/result-acceptance.spec.ts`。
- [ ] **Step 3 — 实现**：纯函数零IO；要求所有必需工作success/验收通过；主管主动finish，无子任务报告时只能NOT_READY。report与outbox意图同事务；没有真实文档时不返回“已生成”。
- [ ] **Step 4 — 绿灯**：上述PASS，属性测试/穷举小图证明无循环误判；同一任务100个并发CAS只允许符合顺序版本的提交。
- [ ] **Step 5 — 提交**：`git commit -m "feat(router-v2): implement versioned graphs and report-driven completion"`。

## Task 5: T05 / P2：动态角色与模型能力准入

**Files:** Create `src/host/v2/roles/{catalog,validation,model-selection,builtins}.ts`, `tests/v2/{role-catalog,model-selection}.spec.ts`。

**Interfaces:** ConsumesRoleDraft/Actor/store；Produces `publishRole(meta,expectedVersion,draft):Promise<Reply<RoleRef>>`、`resolveRole(actor,ref):RoleDefinition`、`selectModel(role,catalog,capabilities):SelectedModel`；类型定义在shared/types。RoleDefinition包括immutable ref/hash/granted ceiling/source；SelectedModel包含configVersion和capability evidence。

- [ ] **Step 1 — 失败测试**：manual_and_model_same_validator、supervisor_cannot_publish_supervisor、worker_designer_requires_request、team_scope_not_global、immutable_versions、disabled_role_does_not_break_old_attempt、16KiB_boundary、8_auto_roles_limit、catalog_failure_blocks_not_allowall、unknown_model_not_silent_fallback。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/role-catalog.spec.ts tests/v2/model-selection.spec.ts`。
- [ ] **Step 3 — 实现**：发布schema拒绝代码/preset配置，source由Actor决定；模型发布自动限scope；权限交集由系统算；请求过大/生成修复超2次进入可见blocked。内置router/supervisor/implementation/test/review/research/designer定义，不为它们生成preset。
- [ ] **Step 4 — 绿灯**：上述PASS；测试运行中v1不因发布v2改变promptHash/model/权限。
- [ ] **Step 5 — 提交**：`git commit -m "feat(router-v2): support versioned manual and generated roles"`。

## Task 6: T06 / P2：逐Agent身份、完整提示词与最终工具guard

**Files:** Create `src/host/v2/runtime/{scope-installer,prompt-composer,tool-guard,mode-binding}.ts`, `src/host/v2/preset-trigger.ts`, `tests/v2/{scope-installer,tool-guard}.spec.ts`。

**Interfaces:** ConsumesT01/T03/T05；Produces `installManagedScope(agent:ManagedAgent,deps:ScopeDeps):()=>void`、`composePrompt(role:RoleDefinition,policy:CommonPolicy):{text:string;hash:string}`；ManagedAgent最小面与真实agent映射在T01契约一致；ScopeDeps含bindings/roles/tool definitions/guard，无任意ctx全量依赖。

- [ ] **Step 1 — 失败测试**：new_root_explicit_mode_only、unbound_child_fails_closed、fresh_fork_resume_same_identity、only_one_complete、required_context_after_compaction、dispose_rolls_back_partial_install、unknown_tool_denied、raw_subagent_workflow_cannot_bypass、ordinary_session_unchanged。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/scope-installer.spec.ts tests/v2/tool-guard.spec.ts`。
- [ ] **Step 3 — 实现**：预登记查身份，根绑定同步持久；每Agent同名完整段仅一次；不在preset祖先写死persona；最终guard覆盖所有本地/继承工具。公共协议不可被角色字符串替换；动态context仅当前授权快照，不污染其他scope。
- [ ] **Step 4 — 绿灯**：单测PASS；在独立宿主分别检查首个实际请求的system/tools/context与冷恢复结果。不能只看注册表/工具描述就宣布guard生效。
- [ ] **Step 5 — 提交**：`git commit -m "feat(router-v2): bind scoped identities prompts and tool enforcement"`。

## Task 7: T07 / P2：预登记创建与单一宿主桥

**Files:** Create `src/host/v2/runtime/{host-port,dsh-adapter,dispatch,dispatch-recovery}.ts`, `tests/v2/{dispatch,dispatch-recovery}.spec.ts`。

**Interfaces:** ProducesHostPort；`prepareDispatch(meta,input):Promise<Reply<DispatchIntent>>`；`driveDispatch(intentId:Id,signal:AbortSignal):Promise<void>`；`reconcileDispatch(intentId:Id):Promise<RecoveryDecision>`。DispatchIntent中reservedChildId从计划至终结不可改变；RecoveryDecision=`retry_same_id|bind_existing|uncertain|terminal`。

- [ ] **Step 1 — 失败测试**：assignment_persisted_before_host_start、same_intent_never_new_child_id、created_before_crash_binds_existing、mismatch_parent_uncertain、messageid_without_durable_evidence_not_active、fork_no_prefix_explicit_spawn、unsupported_model_blocks、second_driver_no_start。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/dispatch.spec.ts tests/v2/dispatch-recovery.spec.ts`。
- [ ] **Step 3 — 实现**：公开startActivation传childId；spawn指定唯一preset，fork遵循宿主组合规则；不手动拼AgentFactory。异常先inspect同ID，已存在不得再次start；初始接受确认与active落账顺序可审计。根/子消息和中断只使用合法公开通道。
- [ ] **Step 4 — 绿灯**：单测PASS；独立宿主在预登记后/创建后/消息接受后/active前各杀掉自己拉起的测试实例并重开，证明无重复child；不触碰桌面进程。
- [ ] **Step 5 — 提交**：`git commit -m "feat(router-v2): reserve identities before durable child activation"`。

## Task 8: T08 / P3：主管团队、领取与成员级授权

**Files:** Create `src/host/v2/domain/{team,claim}.ts`, `src/host/v2/application/{teams,dispatch}.ts`, `tests/v2/{teams,claims}.spec.ts`。

**Interfaces:** ConsumesT04/T05/T07；Producesgraph.dispatch处理、`claimNode(meta,{taskId,nodeId,expectedGraphVersion,memberId}):Promise<Reply<Attempt>>`、`listTeam(actor,teamId):TeamView`；TeamView在shared/views。

- [ ] **Step 1 — 失败测试**：router_only_supervisor、supervisor_only_worker、no_fourth_level、member_name_never_reused、8_members_limit、one_active_attempt_per_member、two_claimants_one_winner、blocked_node_not_claimed、self_no_child、independent_teams_no_cross_read。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/teams.spec.ts tests/v2/claims.spec.ts`。
- [ ] **Step 3 — 实现**：同事务领取/owner/预算占用，delegate按role选择空闲成员或计划创建，复用成员须team/roleVersion/model/权限匹配；主管新开团队不是官方Team；成员创建失败保记录和可诊断attempt，不占用永不释放的正常名额（failed不计active）。
- [ ] **Step 4 — 绿灯**：上述PASS；真实两主管/两团队串行再并行闭环，worker正常report，主管主动finish。
- [ ] **Step 5 — 提交**：`git commit -m "feat(router-v2): add supervisor-owned teams and atomic claims"`。

## Task 9: T09 / P3：可靠消息、outbox、等待和文档物化

**Files:** Create `src/host/v2/runtime/{outbox,mailbox,waiter,document-writer}.ts`, `tests/v2/{outbox,mailbox,waiter,documents}.spec.ts`。

**Interfaces:** ConsumesHostPort/store；Produces `pumpTarget(targetId:Id,signal:AbortSignal):Promise<void>`、`enqueueMessage(meta,input):Promise<Reply<{deliveryId:Id}>>`、`waitForChange(actor,{teamId,afterSeq,timeoutMs},signal):Promise<WaitResult>`；WaitResult=`{changed:boolean;seq:Seq;noProgress:boolean;timedOut:boolean}`。文档副作用用相同intent框架但不启动模型。

- [ ] **Step 1 — 失败测试**：failed_send_stays_retryable、accepted_before_receipt_crash、accepted_not_consumed、same_target_order、pending_byte_count_utf8、cross_team_denied、relay_preserves_sender、wait_no_progress_immediate、event_between_check_subscribe_not_lost、write_conflict_preserves_user_file。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/outbox.spec.ts tests/v2/mailbox.spec.ts tests/v2/waiter.spec.ts tests/v2/documents.spec.ts`。
- [ ] **Step 3 — 实现**：lease和retry/dead_letter持久；只有durable accepted证据后更新，不提前consume；unknown不盲重投。停止不靠消息FIFO，而以guard读权威epoch。文档物化失败保留结果和错误；生成任务书ready后再启动依赖该路径的首条任务。
- [ ] **Step 4 — 绿灯**：上述PASS；宿主投递去重在“已处理+重启”后验证，不能证明则能力面明确unknown并按设计进入uncertain。
- [ ] **Step 5 — 提交**：`git commit -m "feat(router-v2): deliver durable notifications and bounded team messaging"`。

## Task 10: T10 / P3：停止恢复、预算熔断与写范围占用

**Files:** Create `src/host/v2/safety/{stop,budgets,breaker,resources,idle,lifecycle}.ts`, `tests/v2/{stop,budgets,resources,idle,lifecycle}.spec.ts`。

**Interfaces:** ConsumesStore/HostPort；Produces task.control，`emergencyPause(meta,rootRouterSessionId):Promise<PauseReport>`、`admitDispatch(tx,input):Admission`、`observeIdle(attemptId,observation):Promise<void>`、`closeRuntime(signal):Promise<void>`。PauseReport逐session返回frozen/interrupted/confirmed/error；不能仅一布尔ok。

- [ ] **Step 1 — 失败测试**：persist_stop_before_interrupt、late_report_does_not_unlock、timeout60s_uncertain、no_resource_release_on_unknown、emergency_only_current_tree_not_future、user_only_unfreeze、restart_preserves_budget、same_command_not_double_charge、symlink_scope_overlap、waiting_user_no_nudge、max_two_nudges、inactive_ctx_no_unhandled_rejection。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/stop.spec.ts tests/v2/budgets.spec.ts tests/v2/resources.spec.ts tests/v2/idle.spec.ts tests/v2/lifecycle.spec.ts`。
- [ ] **Step 3 — 实现**：时钟/计时器注入；预算与停止均持久事务；tool guard在执行前读取epoch（非只在注册时）；暂停只针对快照选中run，根禁接单另命令。idle仅提醒/blocked，绝不result.success；HMR先停准入再驱动、清理副作用与订阅，所有fire-and-forget用已有safe-async纪律。
- [ ] **Step 4 — 绿灯**：上述PASS；故障注入同时停止+派发+报告+重启，结果只能符合一个提交顺序。
- [ ] **Step 5 — 提交**：`git commit -m "feat(router-v2): enforce cancellation barriers budgets and recovery safety"`。

## Task 11: T11 / P4：Session投影发布与健康诊断

**Files:** Create `src/host/v2/presentation/{read-model,publication,projection,health}.ts`, `tests/v2/{projection,publication,health}.spec.ts`。

**Interfaces:** Produces `buildView(actor,query,view):RouterView`、`publishPendingViews(signal):Promise<void>`、`routerProjectionDefinition`、`healthSnapshot():HealthView`。ViewEvent=`{schemaVersion:1;viewRevision:number;sourceSeq:Seq;rootRouterSessionId:Id;view:RouterView}`；projection key=`routerV2`、stateVersion=1；view只JSON。

- [ ] **Step 1 — 失败测试**：view_fold_no_io、duplicate_and_old_revision_no_frame、invalid_view_keeps_last_good、publish_failure_does_not_rollback_result、worker_view_no_foreign_data、root100_pagination、256KiB_limit、late_publication_rebuild、health_reports_missing_guard_and_oldest_outbox。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/projection.spec.ts tests/v2/publication.spec.ts tests/v2/health.spec.ts`。
- [ ] **Step 3 — 实现**：每target串行发布并合并未发布快照，事件flush后确认；投影只折叠、不读SQLite。viewVersion与sourceSeq明确区分；冷会话回填只用已登记ID并有限批次。日志不含凭证/全消息。
- [ ] **Step 4 — 绿灯**：上述PASS；在真实web断线/重连/HMR/清投影缓存后对照SQLite状态，确认读取不产生业务写入。
- [ ] **Step 5 — 提交**：`git commit -m "feat(router-v2): publish replayable session views and health diagnostics"`。

## Task 12: T12 / P4：工具/API与用户界面统一接入

**Files:** Create `src/host/v2/presentation/{tools,routes}.ts`, `src/host/v2/application/{questions,memory-bridge}.ts`, `src/client/v2/store.ts`, `src/client/v2/{team-panel,task-graph,role-editor,health-panel}.tsx`, `tests/v2/{tools-schema,routes,client-store,client-roles,client-navigation,questions-memory}.spec.ts`; Modify `src/client/index.ts`, `src/client/api.ts`, `src/client/workbench-store.ts`, `src/client/notification-cards.tsx`, `src/client/question-cards.tsx` via integration owner。

**Interfaces:** Tools实现第2.3表，routes为 `/router/v2/state`、`/router/v2/roles`、`/router/v2/commands`、`/router/v2/health`；客户端 `useRouterV2(sessionId):{view,lag,error}` 主读Session store，详情分页API。写命令只到RouterV2.execute，不能UI另起状态机。

另在shared/commands定义用户控制命令：`role.disable{roleRef,expectedVersion}`、`role.promote{roleRef,targetScope,expectedVersion}`、`guard.unfreeze{expectedRevision,reason}`、`router.pause_dispatch{rootRouterSessionId,paused,reason}`、`router.emergency_pause{rootRouterSessionId}`、`question.answer{questionId,expectedRevision,answer}`；全部仅可信user Actor，模型工具不映射这些权限。`claimNativeQuestion({questionId,sessionId,taskId,attemptId,epoch}):Promise<void>`接现有问答桥，`indexAcceptedResult(resultId:Id):Promise<void>`接现有memory adapter，均使用持久幂等记录；history.search读取按Actor过滤。具体工具面与业务模型不得因角色自动生成而改变。

- [ ] **Step 1 — 失败测试**：every_required_key_declared、compile_all_schemas_real_host、actor_not_from_args、csrf_origin_rejected、user_accept_only_user、stale_cas_visible、polling_does_not_dispatch、close_tab_not_cancel、spawn_not_focus_steal、manual_role_publish_same_validation、client_degraded_services_dont_throw。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/tools-schema.spec.ts tests/v2/routes.spec.ts tests/v2/client-store.spec.ts tests/v2/client-roles.spec.ts tests/v2/client-navigation.spec.ts tests/v2/questions-memory.spec.ts`；新增断言restart_expires_orphan_question、skip_is_not_approval、waiting_user_does_not_nudge、memory_failure_does_not_resettle_result、history_cross_workspace_denied、model_cannot_unfreeze_or_promote。
- [ ] **Step 3 — 实现**：团队、图、文档、角色、健康基于统一视图；支持blocked/uncertain真实状态、待确认通知、用户验收和明确重试。普通模式不显示受管操作。错误不只console输出；注入服务声明覆盖apply读取面，降级catch不再抛。
- [ ] **Step 4 — 绿灯**：单测PASS，`npm run build`后运行容器client激活预检；独立web验证成员导航、设置编辑、任务图、通知与无轮询派发副作用。
- [ ] **Step 5 — 提交**：`git commit -m "feat(router-v2): expose unified tools and team management UI"`。

## Task 13: T13 / P4：旧会话分流、导入与回退

**Files:** Create `src/host/v2/migration/{inventory,legacy-binding,import-router,import-kernel,manifest,rollback}.ts`, `scripts/v2/migrate.mjs`, `tests/v2/{migration,legacy-presets,rollback}.spec.ts`。

**Interfaces:** `inventory(source):Promise<MigrationInventory>`、`planImport(inventory):ImportPlan`、`applyImport(plan,store):Promise<MigrationManifest>`、`verifyImport(manifest):Promise<VerificationReport>`。source显式 `router|kernel`+绝对路径，默认dry-run；Manifest记录sourceHash/版本/ID映射/计数/警告/目标seq。

- [ ] **Step 1 — 失败测试**：dry_run_no_writes、repeat_import_idempotent、active_task_stays_legacy、unknown_parent_not_guessed、system_judged_source_preserved、old_fork_not_subagent、all_old_preset_ids_resolve、kernel_source_requires_explicit_flag、same_session_two_owners_rejected、rollback_with_v2_outbox_preserves_data。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/migration.spec.ts tests/v2/legacy-presets.spec.ts tests/v2/rollback.spec.ts`。
- [ ] **Step 3 — 实现**：旧task/role/问题/提示覆盖/熔断留痕；活动任务不自动切；legacy无descriptor走原controller兼容，不改header。兼容preset仍可见如实标注，不发明hidden字段。Kernel导入仅用户显式指定离线来源，未提交工作树不被修改。
- [ ] **Step 4 — 绿灯**：单测PASS；临时数据目录演练完整备份→dry-run→导入→重复→回退，验证总数/hash/关系/报告来源不变。
- [ ] **Step 5 — 提交**：`git commit -m "feat(router-v2): migrate history with explicit legacy ownership and rollback"`。

## Task 14: T14 / P4：统一入口装配与旧模块退役边界

**Files:** Modify `src/entry.ts`, `src/host/presets/{dynamic,lifecycle}.ts`, `src/{tools,context,prompt-section}.ts`, `cordis.patch.yml`, `package.json`, `README.md`, `docs/requirements.md`; Create `src/host/v2/bootstrap.ts`, `tests/v2/{bootstrap,preset-surface}.spec.ts`。

**Interfaces:** `bootstrapRouterV2(ctx:V2HostContext,config:V2Config):Promise<()=>Promise<void>>`；config新增 `protocolV2Enabled:boolean` 默认false，dataDir沿用现状；后续启用只作用新根会话。已有RouterBinding决定新旧工具/定时器所有者。

- [ ] **Step 1 — 失败测试**：one_current_entry_no_duplicate_id、old_aliases_compatible、new_role_never_registers_preset、same_session_single_engine、flag_off_legacy_unchanged、v2_db_failure_readonly_diagnostics、query_zero_side_effects、ordinary_mode_unmodified。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/bootstrap.spec.ts tests/v2/preset-surface.spec.ts tests/bundle.spec.ts tests/executor-preset.spec.ts`。
- [ ] **Step 3 — 实现**：集成人员修改共享入口，静态dsh-router取代同ID动态所有者；旧preset登记仅为历史恢复。新角色不重载preset。root entry拆装配函数不继续堆业务。更新requirements新协议章节并明确legacy保留条款；本设计批准后才将其规定提升为现行需求。
- [ ] **Step 4 — 绿灯**：全三门禁；声明行/兼容动态行/产物接线检查。版本范围由T01支持矩阵决定（现有范围不能在能力不足时仍声称v2支持）；不因探到版本变化擅自升级宿主。
- [ ] **Step 5 — 提交**：`git commit -m "refactor(router): integrate one preset and protocol-isolated runtimes"`，连同本任务构建产物提交。

## Task 15: T15 / P5：故障矩阵、真实宿主验收与发布交接

**Files:** Create `tests/v2/{chaos,e2e-contract}.spec.ts`, `scripts/v2/acceptance.mjs`, `docs/research/2026-11-14-router-v2-acceptance.md`, `docs/router-v2-operations.md`；修改仅由验收发现的最小缺陷交回原负责人处理。

**Interfaces:** 验收输出机器可读 `{host,version,model,scenario,status,evidence,startedAt,finishedAt}`，status=`pass|fail|blocked|untested`；程序退出码0只在所有必需场景pass时返回，skip不能算pass。

- [ ] **Step 1 — 失败测试**：实现设计§13 A–J全部矩阵，尤其每个创建/投递断点、并发CAS、两团队消息隔离、官方Team同时启用时工具名无冲突、第二宿主、HMR、恢复旧preset、未收集UI测试探测。
- [ ] **Step 2 — 红灯**：`npx vitest run tests/v2/chaos.spec.ts tests/v2/e2e-contract.spec.ts`；真实测试未配置时blocked而非假绿。
- [ ] **Step 3 — 实施验收**：只启动独立DSH_HOME的web实例；小规模真实模型：Router→2主管→每主管2成员、手建/自动角色各一、一失败/一返工/一用户验收，主动report/finish闭环。再注入断点和停止，不以模型自然收尾代提交。
- [ ] **Step 4 — 全门禁与审查**：运行下表；独立评审检查全分支，不只各任务测试。所有P0/P1问题修复且复跑；未通过项留阻塞，禁止“已实现待验证”作为上线结论。
- [ ] **Step 5 — 发布交接提交**：`git commit -m "test(router-v2): verify recovery isolation and end-to-end delivery"`；提交验收报告。Lead按仓库流程合并、重建、产物提交；提示用户退出重开桌面，用户完成前不宣布桌面已生效。

## 3. 最终验证命令与证据要求

| 检查 | 命令/方式 | 判据 |
|---|---|---|
| 类型 | `npm run typecheck` | exit 0 |
| 全测试 | `npm test` | exit 0，新增测试实际被发现，现有1109基线不得无理由删除 |
| 构建 | `npm run build` | exit 0，产物入库、重复构建无字节漂移 |
| 声明行 | `node /Users/good/github/dsh-plugins/scripts/check-host-rows.mjs dsh-router` | 两宿主0问题；注意脚本默认扫主仓，worktree候选须用临时检出/支持的显式文件入口核查，不能以主仓绿替代候选绿 |
| 动态兼容行 | `node scripts/check-subrows.mjs` | 与本次候选定义一致的真实导入/Config校验通过 |
| 客户端 | `node /Users/good/github/dsh-plugins/scripts/check-client-activation.mjs dsh-router` | 重建候选bundle后PASS；同样确保检查的路径是候选而非旧主仓 |
| 实机 | `node scripts/v2/acceptance.mjs --profile <临时profile> --data-dir <临时DSH_HOME>` | 必需场景全pass，含artifact/日志证据，未暴露token |
| 安装 | 独立web装载审计/启动图/页面真实渲染 | 无failed import、无inactive entry、功能可见且可用 |
| 完成评审 | 独立review员按设计§13逐项核对 | 无未解决P0/P1，不把建议写范围当权限 |

候选检查不能修改运行中的本地link仓库来“试一下”；可使用隔离复制profile和显式候选包路径。发布阶段才将经过验证的提交合主干。若web测试走GitHub安装，遵守先提交推送再正常安装；未获需要的远程发布授权时先做本地独立profile验证并说明安装路径尚未验。

## 4. 需求覆盖索引与自审

| 设计章节 | 责任任务 |
|---|---|
| §1–3产品/层级/边界 | T01/T03/T08/T14 |
| §4数据/事务/文档 | T02/T03/T09/T13 |
| §5任务/图/主动报告/验收 | T04/T08/T10 |
| §6单preset/身份/完整提示/guard | T01/T06/T07/T14 |
| §7动态角色/模型 | T05/T12 |
| §8团队/消息/等待 | T08/T09 |
| §9创建/恢复/停止/预算/范围 | T02/T07/T09/T10/T15 |
| §10UI/投影/API/健康 | T11/T12 |
| §11迁移/兼容/回退 | T13/T14/T15 |
| §12旧模块处置 | T13/T14 |
| §13–14验收与阶段 | T01/T15/团队交接 |

实施者不得把此文接口名误认宿主API。T01是公开宿主契约的前置证据；能力不可用时暂停依赖任务并提交变更请求，不绕过初始化或伪造descriptor。

自审记录：本计划区分待批准设计和事实、包含读权限/commandId反例、未将complete当上下文隔离、未将投影作为第二真源、未把legacy兼容别名说成不可见、未把工具提交与外部自判混为一谈。所有任务需完成测试红灯→最小实现→绿灯→独立审查→提交；提供代码骨架的测试辅助函数由对应测试文件明确定义，不引入未实现生产依赖。
