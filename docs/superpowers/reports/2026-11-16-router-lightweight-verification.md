# Router 轻量协作验证报告（2026-11-16）

对应计划 Task 4（完整装配验证、退役边界与交接）。BASE `21ec1c19c67937ff616db1e51f1e61d9db95bcf`，
分支 `docs/router-lightweight-design`。四层此前已验收（见 ledger），本报告覆盖 Task4 的
Phase A–D：context order 修正、native-flow 调查（缺口）、退役映射、文档同步、最终门禁。

## 四层验收回顾（前序任务，证据见 ledger）

| 层 | 内容 | 结论 |
| --- | --- | --- |
| Layer1 | `src/collaboration/{types,records,roles}.ts` + owned tests（存储/角色模板、UUID 准入、路径守卫、串行/原子写） | ACCEPTED `35c636e` |
| Layer2 | `src/collaboration/{tools,prompt,context}.ts` 纯定义（七工具、统一提示词、上下文构建） | ACCEPTED `46e3d8f` |
| Layer3 | 单 preset/runtime/宿主入口 + native-flow 预检（`28179c6` + 修复 `f6e900a`/`21ec1c1`） | ACCEPTED `21ec1c1` |
| Layer4 | 协作工作台只读 UI + 模板编辑 + 宿主装配加固 | ACCEPTED `21ec1c1` |

## Phase A — context order 修正（Layer3 review Minor1）DONE

`src/context.ts` 的 `order` 曾声明为 `Schema.number().default(100).volatile()`。`.volatile()` 把解析值
包成引用对象 `{ get(), [write]() }`（`@deepseek-ai/cosmokit` `createVolatile`），导致 `apply` 里
`typeof config.order === 'number'` 恒为 false，order 永远回退 100。已用实测确认：`C({order:17}).order`
`typeof==='object'`、`.get()===17`。

裁定：`order` 是行加载时一次性给定的静态值、不做运行时更新，`.volatile()` 契约不当，改为普通
`Schema.number().default(100)`。实测普通 `Schema.number().default(100)` 产出 `typeof==='number'`。出货
preset（`cordis.patch.yml`）本就显式 `order: 100`，运行时行为不变；修正让非默认 order 真正生效。

TDD：`tests/collaboration/context.spec.ts` 新增「Config order registration」块。RED：
`Config({order:17})` 注册 order 100（期望 17）；GREEN 后 10/10；`npm run typecheck` exit 0。

## Phase B — native flow 调查：LIVE FLOW SKIPPED（精确缺口，非 fake PASS）

目标：用候选 preset 驱动真实 DSH 两级协作（Router→主管→成员），不用付费模型。调查顺序：官方文档 →
已装 CLI 源码。

关键事实（一手来源）：

1. 官方设计里确有可 cordis 加载的脚本化 LLM seam `@deepseek-ai/dsh-llm-replay`
   （`docs/official/reference/config-catalog.md` §llm-replay，`inject:['llm']`），从录制的 v4 会话日志
   回放每次模型调用；但 `loadSessionScripts` 里每个 `childFiles` 都要经 `deriveReplayScript(fixture.events)`
   变成脚本——**子会话（主管/成员）脚本只能来自真实录制的会话日志**，只有主会话能用 bare
   `ReplayEntry[]` sidecar（`overrideFile`）替换。没有公开 API 能在无先验录制的情况下合法合成一套
   v4 多会话 fixture。作者工具（`dsh-session-snapshot`/`dsh-agent-loop-testkit`/`dsh-llm-mock-server`）
   都是「库包（无插件入口）」，且都未安装。
2. `dsh-llm-replay` **不在任何可达宿主**：已装全局 CLI `@deepseek-ai/dsh` 0.2.1-rc.2 的
   `node_modules/@deepseek-ai/` 无该包；桌面 app.asar（0.2.2-rc.1）也无（只有 `packages/subagent/*`
   的内部 `test-support/test-agent.js` 夹具，非公开导出）。
3. 官方 `providers.md` 显示每条模型路由都要真实凭据；CLI `dsh headless` 必须走付费/网关模型。

结论：可达宿主上不存在「无付费模型的真实 Agent 脚本化注入点」。按 brief：这是文档化缺口，不据此
halt；未改宿主、未造通信层、未恢复旧运行时、未 fake PASS。

产物：
- `tests/collaboration/native-flow.spec.ts`：`native_hierarchy_and_reports` 与
  `partial_actions_are_visible` 写成 `it.skip`，登记同一条缺口原因；不执行、不计 PASS。它们描述了
  一旦有可驱动 seam + fixture 构造能力就要成立的机制契约（两层深度、初始角色消息含
  rootSessionId/parent/报告路径、模板文本传递、成员结束不改 workLabel、部分动作可见），转正式为
  填驱动任务而非重写。
- `scripts/check-collaboration-host.mjs`：候选绝对路径、双宿主的宿主声明核查，复用真实
  `validate-row.ts` 加载路径证每条候选行 import + 过包 Config，并只读断言单预设组合继承
  （单 `dsh-router/Router` complete:true + 原生 subagent spawn/maxDepth 2 + 无旧别名）。运行结果：
  桌面 0.2.2-rc.1 18 行全过、CLI 0.2.1-rc.2 18 行全过，组合继承断言绿，exit 0。**只证声明面，不 claim
  live agent flow。**

## Phase C — 退役 + 文档

引用搜索（grep/glob + 导入图可达性分析，非记忆）：以新生产入口（`src/entry.ts`、`src/tools.ts`、
`src/context.ts`、`src/client/index.ts`）+ 保留测试（`tests/collaboration/*`、`bundle`/`entry`/
`tracked-install`/`preset-rows`/`validate-row`）+ 核查脚本为根做正向可达性分析。新生产代码**零引用**
`src/host/*`、`src/compaction.ts`、`src/prompt-section.ts`、旧 `src/client/*`、`src/shared/*`。

退役映射表（退役功能 → 替代验证）：

| 退役模块/功能 | 替代验证 |
| --- | --- |
| `src/host/ledger/*`（账本 store/machine/scheduler/errors） | 记录存储由 `src/collaboration/records.ts` 替代，验证 `tests/collaboration/records.spec.ts`（35 用例） |
| `src/host/guard/*`（adjudicator/breaker/budgets/classify/emergency/notifications） | 业务裁决由模型替代（设计 §2/§5），无自动闸门；记录工具错误如实返回由 `tests/collaboration/tools.spec.ts`（30 用例） |
| `src/host/memory/*`（adapter/retrieval/store/summarizer 三层记忆） | 三层记忆退役（设计不做）；`tests/memory-*.spec.ts` 一并退役 |
| `src/host/bridge/*`（questions/router-adoption/sessions/tabs）+ `src/host/session/*`（收编/索引/尾扫） | 工作台只读资料由 `src/collaboration/routes.ts` + `collaboration-panel` 替代，验证 `tests/collaboration/{routes,host-routes,panel}.spec.ts` |
| `src/host/presets/{dynamic,lifecycle}` + `src/prompts/*`（身份卡/统一/主管/worker/会话提示词）+ `src/host/templates.ts` + `src/host/tools/index.ts`（旧角色工具） | 单 preset + 协作提示词由 `src/collaboration/prompt.ts` + `cordis.patch.yml` 静态预设行替代，验证 `tests/collaboration/{preset,prompt}.spec.ts` + `preset-rows.spec.ts` |
| `src/host/compaction/*` + `src/host/context/*` + `src/compaction.ts` + `src/prompt-section.ts`（摘要替换/压缩驱动/旧上下文段） | 保留宿主默认压缩；协作上下文由 `src/collaboration/context.ts` 替代，验证 `tests/collaboration/context.spec.ts`（10 用例） |
| `src/host/{core,core-types,model-ref,observability,routes,root-config,safe-async}` + `src/host/docs/*` + `src/host/compaction/task-summary` | 旧执行/路由/观测引擎整体退役；装配由 `src/entry.ts` 单入口替代，验证 `tests/entry.spec.ts` + `tests/collaboration/host-entry.spec.ts` |
| `src/client/{api,back-button,client-prefs,notification-cards,notification-model,overlay-queue,question-cards,question-state,session-output,session-windows,settings-model,settings.tsx,surface-ids,tabs-model,workbench-store,workbench-tabs}.tsx` + `src/shared/{types,view-contract,fs-adapter}` | 工作台由 `src/client/collaboration-{api,store,panel}.tsx` 替代，验证 `tests/collaboration/{collaboration-api,collaboration-panel via panel,collaboration-store}.spec.ts` |
| 旧 HTTP 路由 `/router/tasks/control` 等 + 失控防护 + 收编诊断 `docs/router-adoption-operations.md` | 首版工作台只读任务资料、不自动验收/补做/换人（设计 §6）；路由由 `src/collaboration/routes.ts` 收敛为 `/router/collaboration/*`，验证 `tests/collaboration/host-routes.spec.ts`（旧 routes-*.spec.ts 退役） |

保留（仍被引用）：
- `src/client/ui-kit.tsx`：被保留的 `tests/entry.spec.ts`（形状断言）引用。
- `src/host/presets/validate-row.ts`：被核查脚本 `check-subrows.mjs` / `check-collaboration-host.mjs`
  引用；其测试 `tests/validate-row.spec.ts` 仍覆盖这条活的打包校验路径，保留。
- 旧测试按「仅测退役模块」判据退役；保留测试仅覆盖 collaboration/* 与活的打包/装配/文件安全。

文档同步：`README.md`、`docs/requirements.md`、`AGENTS.md` 全部重写为轻量协作设计；删除退役功能
的独立操作文档 `docs/router-adoption-operations.md`。旧用户数据与历史分支不删。

## Phase D — 最终门禁（实测）

执行目录：候选 worktree `docs/router-lightweight-design`，绝对路径作为候选参数传入核查脚本。

- `npm run typecheck`：exit 0（`tsc --noEmit` + `tsc --noEmit -p tsconfig.tests.json` 两遍）。
- `npm test`：**18 文件通过 / 1 跳过（19），229 通过 / 2 跳过（231）**，exit 0。测试数随退役
  下降（计划明确允许，不虚增）；2 个 SKIPPED 是 native-flow 缺口，不计 PASS。
- `npm run build`：exit 0，产出 `dist/{entry,tools,context}.js`（+`.map`）与 `lib/client.js`（+`.map`）。
- 重复 build 字节比对：`dist/entry.js`、`dist/tools.js`、`dist/context.js`、`lib/client.js`
  两次构建 md5 **完全一致**（可复现）。
- `git diff --check`：clean（无空白错误）。
- tracked 产物改动面：仅 `dist/context.js`（+`.map`）变化——context.ts 是宿主侧文件；entry/tools/
  client bundle 未变。无 stray `dist/client/`、`*.d.ts*` 中间文件被跟踪。
- `tests/tracked-install.spec.ts`：4/4 绿（干净 tracked 副本里 entry/tools/context/client 不依赖
  ignored dist 中间文件即可装配）。
- `scripts/check-collaboration-host.mjs "$(pwd)"`：桌面 0.2.2-rc.1 与 CLI 0.2.1-rc.2 各 18 行全过
  + 组合继承断言绿，exit 0。
- `scripts/check-subrows.mjs`：两宿主各 18 行全过，exit 0。
- `scripts/check-collaboration-client.mjs "$(pwd)"`：PASS（正常路径注册
  `router-collaboration-workbench`；12 项故障/降级均不穿透），exit 0。
- 容器 `check-host-rows.mjs dsh-router`：两宿主全过，exit 0。

commit message：`test(router): verify lightweight collaboration and document cutover`。仅交付候选分支；
未合 main、未推送、未安装、未改运行中的 profile、未重启桌面、未调用付费模型、未触碰 Kernel。
