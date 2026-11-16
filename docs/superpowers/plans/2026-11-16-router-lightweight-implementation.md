# Router Lightweight Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用单一 Router 入口、DSH 原生子会话和轻量文件记录支持模型自主团队协作。
**Architecture:** 模型负责决策，DSH 负责通信与运行，插件只保存资料、提供规则和展示。替换旧装配，不合入此前 v2 事务协议及迁移候选。
**Tech Stack:** TypeScript、Cordis、Node 文件 API、React、Vitest、tsdown；不新增数据库或运行依赖。
**Spec:** `docs/superpowers/specs/2026-11-16-router-lightweight-design.md`（2026-11-16 用户已确认，设计提交 bed8c31）。

## Global Constraints

- 仅一个用户可选 preset，id=`dsh-router`；包名保持 `@goodjin2/dsh-router`；统一完整协作提示词 `complete: true`。
- Router→主管→成员；本地 spawn，绝对 maxDepth=2；消息和结束通知使用 DSH，不做自有投递队列。
- 角色是提示规则，不增加业务授权矩阵；保留宿主通信权限、正常工具审批及网页登录准入。
- 新数据使用插件数据根的 `collaboration/`；不扫描、导入、接管旧会话或数据，不删除旧用户数据。
- 工作标签仅“待处理、进行中、受阻、已报告”；模型/用户填写，不从会话结束或测试退出码推断业务完成。
- 保存、创建子会话、通知是独立动作；不得自动补偿、重派、验收、换人或恢复执行。
- 单宿主写记录，进程内串行且单文件原子替换；不承诺多宿主共享目录和多文件事务。
- 独立实现工作区基于本设计分支；不改运行中 profile、不重启桌面、不自动 main 合并/推送/部署。
- 仓库三门禁与入库产物保持一致；新要求覆盖旧 docs/requirements.md 的冲突项，须同步文档，不同时保留两套“当前架构”。

## Review Focus

1. 保存失败后仍返回成功/发出消息：记录工具必须只有 IO 副作用，失败明确返回（任务1、2）。
2. DSH 已创建子会话但模型未保存关联：保留真实 childId，由模型补记，不另建子会话；提示词与演练覆盖（任务2、4）。
3. 共享 preset 的子会话误当根 Router：主管/成员初始消息需自足，含职责、上级、材料与目录；真实两层演练验证（任务2、4）。
4. UI 把运行结束显示成业务成功，或错误响应变空列表：独立展示、不改标签、显示错误（任务3）。
5. 去掉旧入口却仍启用自动收编、判定、压缩替换或旧控制路由：装配测试证明未注册，产物闭包及临时宿主演练确认（任务2、4）。

## 文件与公共接口（先固定名称，避免子任务各自造接口）

新代码集中于 `src/collaboration/`（records.ts、types.ts、roles.ts、tools.ts、prompt.ts、context.ts、routes.ts、runtime.ts）；新 UI 为 `src/client/collaboration-{api,store}.ts`、`src/client/collaboration-panel.tsx`。每文件一个职责，不建立通用命令总线。

```ts
// src/collaboration/types.ts；Date.now() 毫秒时间，正文原样保存。
type RecordKind = 'task' | 'assignment' | 'report' | 'summary'
type WorkLabel = '待处理' | '进行中' | '受阻' | '已报告'
interface SessionLink { sessionId: string; label: string }
interface ArtifactRef { location: string; label: string }
interface RecordDraft {
  kind: RecordKind; taskId?: string; parentRecordId?: string
  title: string; body: string; workLabel?: WorkLabel
  sessions?: SessionLink[]; artifacts?: ArtifactRef[]
}
interface WorkRecord extends RecordDraft {
  id: string; taskId: string; rootSessionId: string; createdAt: number; updatedAt: number
}
type RecordPatch = Partial<Pick<RecordDraft, 'title' | 'body' | 'workLabel' | 'sessions' | 'artifacts'>>
interface RecordQuery { taskId?: string; kind?: RecordKind }
interface SavedRecord { record: WorkRecord; path: string }
interface RoleTemplate { id: string; name: string; description: string; createdAt: number; updatedAt: number }
interface RecordStore {
  create(rootSessionId: string, input: RecordDraft): Promise<SavedRecord>
  read(rootSessionId: string, taskId: string, recordId: string): Promise<SavedRecord>
  list(rootSessionId: string, query?: RecordQuery): Promise<WorkRecord[]>
  update(rootSessionId: string, taskId: string, recordId: string, patch: RecordPatch): Promise<SavedRecord>
}
interface RoleStore {
  list(): Promise<RoleTemplate[]>
  read(id: string): Promise<RoleTemplate>
  save(input: { id?: string; name: string; description: string }): Promise<RoleTemplate>
}
```

数据布局：`collaboration/roots/<sha256(rootSessionId)>/tasks/<taskId>/<recordId>.json`；新任务 id=taskId，其他记录必须引用已存在任务。taskId/recordId/roleId 为程序生成 UUID，拒绝任意路径；角色位于 `collaboration/roles/<roleId>.json`。rootSessionId 哈希仅用于文件名，不产生权限。正文和原会话ID保存在JSON内，无全局索引/Markdown副本。

`createRecordStore(dataDir: string): RecordStore`、`createRoleStore(dataDir: string): RoleStore` 由根服务单实例创建。dataDir 为原插件数据根，不是 collaboration 子目录；调用时拼一次新命名空间。时间和UUID通过可注入依赖供单测固定。种类、归属和创建时间不可更新；parentRecordId如提供仅核同任务记录存在，不校验角色权限或任务图。

所有记录/模板操作返回 `INVALID_INPUT | NOT_FOUND | CORRUPT_RECORD | IO_ERROR` 的结构化错误；只核必需字符串、字段类型、枚举、编号及目录范围。空body合法，空title/name不合法；成功列表按createdAt/id排序。保存异常不更改原文件；临时文件只在目标目录创建并在失败后清理。仅处理插件生成的普通文件，路径上的不受支持链接明确拒绝，不研究敌对同进程沙箱。

### Task 1: 轻量记录与角色模板

**Files:** Create `src/collaboration/{types,records,roles}.ts`、`tests/collaboration/{records,roles}.spec.ts`。
**Interfaces:** 产生上述 RecordStore/RoleStore；不依赖旧 TaskLedger、RouterCore 或 DSH。

- [ ] 写失败测试：`record_roundtrip` 断言新task的id=taskId、read得到完整正文和实际path；`report_own_file` 断言两个report路径不同；`explicit_label` 断言更新仅按patch发生。
- [ ] 写边界测试：`failed_save_preserves_original` 注入rename失败后read仍为旧正文；`serialized_updates` 并发排队两次更新后文件可解析、最后提交生效；`bad_id_rejected` 对`../x`拒绝；`missing_and_corrupt` 分别NOT_FOUND/CORRUPT_RECORD；`roles_manual_model_same_store` 两调用方保存后共同可读。
- [ ] 运行 `npx vitest run tests/collaboration/records.spec.ts tests/collaboration/roles.spec.ts`，先确认缺模块/行为断言RED，保留结果。
- [ ] 最小实现字段检查、独立JSON文件、进程内写队列及临时文件rename；不引入事件日志、序号、token、数据库或自动动作。
- [ ] 重跑相同测试及 `npm run typecheck`，全部PASS；提交本任务文件，提交信息 `feat(router): add lightweight work records and role templates`。

### Task 2: 单入口、协作规则及宿主接线

**Files:** Create `src/collaboration/{tools,prompt,context,runtime}.ts`、`tests/collaboration/{tools,preset,runtime}.spec.ts`；Modify `src/{entry,tools,context}.ts`、`cordis.patch.yml`、`scripts/gen-patch-yml.mjs`、`tsdown.config.ts`、`package.json`、`tests/{bundle,entry,tracked-install}.spec.ts`；旧入口测试按下述退役规则调整。
**Interfaces:** `buildCollaborationTools(records: RecordStore, roles: RoleStore): ToolDefinition[]` 沿用宿主tools.register定义形状；`collaborationPrompt: string`；`createCollaborationRuntime({dataDir}): {records: RecordStore; roles: RoleStore; dataDir: string}`。根服务名 `routerCollaboration`；工具和上下文行声明 inject，不再提供/调用 routerCore。

- [ ] 写失败测试：只注册七个工具 `router_record_create/read/list/update`、`router_role_list/read/save`；记录工具不接收角色参数、不调用subagents、不发消息；保存失败原样成为tool error。
- [ ] 固定工具参数：四个record工具均要求rootSessionId；read/update另需taskId/recordId，create接RecordDraft，list接RecordQuery；角色工具直接对应RoleStore参数。当前工具执行会话ID从exec.agent.id取得，仅用于显示默认根建议，不猜子会话根或建立权限。
- [ ] 上下文行仅说明当前会话ID、新记录根目录、七个工具用法；子会话按派发消息中明确的rootSessionId访问资料。缺少任务上下文时向上级询问，不自动认领旧数据。
- [ ] 写 `preset_one_entry`：只有`dsh-router`可选；complete=true；使用官方spawn和控制工具、maxDepth=2；无旧executor/worker/supervisor别名；无角色动态preset注册。保留官方项目指令/默认压缩/用户提问工具；统一规则不要求角色模型不同。
- [ ] 写 `runtime_no_business_engine`：构造/装载只创建记录与模板服务，不导入/调用旧scheduler、adjudicator、adoption、memory后台摘要、预算熔断或任务控制路由；不扫描宿主历史，不绑定业务完成监听器。
- [ ] 运行 `npx vitest run tests/collaboration/tools.spec.ts tests/collaboration/preset.spec.ts tests/collaboration/runtime.spec.ts tests/bundle.spec.ts tests/entry.spec.ts tests/tracked-install.spec.ts`，确认RED后实现。
- [ ] 重写薄src/entry.ts和tools/context入口，生成一条静态Router preset；prompt明确“先记录→原生派发→补记childId”“先保存报告→原生通知”“消息失败由模型决定下一步”“没有明确角色的新根才是Router”。不实现dispatch_task/complete_task替代品。
- [ ] 停止发布旧prompt-section/compaction子入口（不再装配）；删除其exports/build entries前搜索全部引用；旧内部模块先不做无关重构，后续整体验证确认无生产引用后处理。不得为了省事删除仍适用的测试。
- [ ] 重跑上述测试、`npm run typecheck && npm run build`；提交源码、声明及全部受影响tracked产物，提交信息 `feat(router): use one model-led preset and native subagents`。

### Task 3: 只展示事实的工作台与模板编辑

**Files:** Create `src/collaboration/routes.ts`、`src/client/collaboration-{api,store}.ts`、`src/client/collaboration-panel.tsx`、`tests/collaboration/{routes,panel}.spec.ts`；Modify `src/entry.ts`、`src/client/index.ts`；按独立性复用 `src/client/ui-kit.tsx` 等展示组件，禁止引入旧workbench业务服务。
**Interfaces:** 路由前缀`/router/collaboration`；GET `/records`（rootSessionId/taskId/kind）、GET `/record`（rootSessionId/taskId/recordId）、GET `/roles`、POST `/roles`（RoleStore.save输入）；记录修改由工具负责，首版工作台只读任务资料。HTTP沿用现有connection.admit登录准入，不新增业务ACL。

- [ ] 固定客户端 `createCollaborationApi(fetch): {listRecords(rootSessionId,query?): Promise<WorkRecord[]>; readRecord(rootSessionId,taskId,recordId): Promise<SavedRecord>; listRoles(): Promise<RoleTemplate[]>; saveRole(input): Promise<RoleTemplate>}`；失败不变成空数组，显示具体错误及重试按钮。
- [ ] 写 `routes_reuse_store`：UI模板保存与模型工具共享同一RoleStore；未登录沿用宿主拒绝；保存错误不返回200；旧`/router/tasks/control`等路由未注册。
- [ ] 写 `panel_distinguishes_facts`：模型标签“进行中”搭配宿主本轮结束时仍显示“进行中”；宿主未知显示未知，不写记录；报告展示署明“模型报告”，无自动成功/验收/重试操作。
- [ ] 写 `panel_links_and_scope`：根会话默认以当前会话ID浏览；提供明确的根会话ID输入框，子会话按任务消息提供的ID打开资料，不自动扫描所有根或猜项目。面板记住用户本次选择；跳转使用记录内sessions的精确sessionId调用宿主openSession，成果引用不自动读取执行。
- [ ] 运行 `npx vitest run tests/collaboration/routes.spec.ts tests/collaboration/panel.spec.ts` 确认RED，再实现列表、详情、模板编辑及会话跳转。用现有会话栏插槽挂一个工作台入口，不复制全套浮窗/通知体系。
- [ ] 宿主运行状态只读已公开的UI/会话投影，接口不可用显示未知；不为状态展示扫描历史或新建后端会话控制服务。面板打开/用户刷新时更新资料，不增加自动执行轮询器。
- [ ] 重跑定向测试、`npm run typecheck && npm run build`，提交客户端与宿主产物，提交信息 `feat(router): show collaboration records without automated adjudication`。

### Task 4: 完整装配验证、退役边界与交接

**Files:** Create `tests/collaboration/native-flow.spec.ts`、`scripts/check-collaboration-host.mjs`、`docs/superpowers/reports/2026-11-16-router-lightweight-verification.md`；Modify `README.md`、`docs/requirements.md`、`AGENTS.md`及旧失效接线测试/脚本。
**Interfaces:** native-flow通过真实本地DSH Manager及候选preset，使用受控无付费模型测试驱动执行规定工具调用；不是模拟Manager自发PASS。检查脚本参数 `--candidate <绝对工作区> --host <cli|desktop> --output <owned目录>`，仅创建合成记录和临时宿主。

- [ ] 写并先运行 `native_hierarchy_and_reports`：Router真实创建主管、主管真实创建成员；检查两层深度、初始角色说明/rootSessionId、成员报告及父级通知、模板文本传递；成员结束不改记录标签。未加载候选时应失败，不用旧main的成功替代。
- [ ] 写 `partial_actions_are_visible`：保存报告后消息调用失败，报告仍可读且失败返回模型；创建成功但记录写失败仍保留childId，不启动第二个child。只验证机制，测试驱动不自动判定业务完成。
- [ ] 编写候选检查入口，调用官方公开Manager，不打开真实profile、不重启桌面、不用付费模型。CLI与桌面Electron-as-Node分别解析候选声明并跑可支持的本地流程；若接口不可用给出精确缺口和当前步骤，停止该阶段，不改宿主/造新通信层。
- [ ] 更新README、requirements、AGENTS：以本设计为当前需求，明确旧数据不兼容、模型决策与单宿主记录限制；按引用搜索解除旧自动服务和旧UI入口。可以移除确实退役的源码/测试，但提交中列出“退役功能→替代验证”；不得批量删除仍适用的文件安全/宿主装配测试。旧数据和历史分支不删。
- [ ] 运行 `npm run typecheck && npm test && npm run build`；重复build比较所有tracked产物字节；`git diff --check`通过。以本阶段实际测试数报告，不要求维持旧协议测试数量。
- [ ] 验证干净tracked副本的entry/tools/context/client加载，不依赖ignored dist中间文件。双宿主声明检查及客户端激活检查必须以候选绝对路径运行，不能误验main；容器脚本不支持候选参数时用本任务本地wrapper复用其检查逻辑，不改容器脚本或生产profile。
- [ ] 完成一次整分支独立审查，聚焦本设计九项范围与上述真实流程，不恢复旧协议故障矩阵。功能问题先给出具体调用链和影响；相同问题修复后仍失败则停下来裁定，不自动无限加轮。
- [ ] 提交报告和文档，提交信息 `test(router): verify lightweight collaboration and document cutover`；仅交付私有候选分支，未获批准不合main/推送/安装。真实用户任务和可见界面确认在后续用户批准的试用阶段，不以受控演练冒充模型产出质量。

## 自审与执行交接

覆盖：规格§1–5→任务2；§6→任务1；§7→任务1/2；§8→任务3/4；§9→任务2/4；§10→任务4。类型与工具/路由均引用同一RecordStore/RoleStore；任务标签不是宿主状态；根会话ID仅资料定位，非权限；模板是文本，不扩成技能插件装配。

只有四个可独立测试的交付步骤，无独立迁移/权限/消息状态机任务。准备工作、文档和产物随对应交付提交，旧方案不再逐项补完。初始基线三门禁应在开始实施前运行并保存；本次仅写计划，未执行任何产品测试或代码实现。

执行方式：此前用户选择团队实施；该偏好保留。建议本计划仍采用串行单实现者+独立审查，不并行改入口与界面共享接口，不派大规模调查团队。用户先审阅本计划；若希望改为本会话直接实现、最后一次整体验收，也可明确切换。计划确认前不开始实施。
