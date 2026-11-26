# dsh-router 仓库纪律

DSH Router：**由模型主导的团队协作插件**（两级模型：Router 主会话直接担任主管——接任务、拷问式
对齐、组队、派发、汇审；成员执行；模型决策、DSH 通信、插件保存资料）。归属映射：**会话任务编排
（拆分、派发、追踪、汇总）→ 本仓 `dsh-router`**。
当前架构的唯一权威是两级模型设计
[`docs/superpowers/specs/2026-11-24-router-two-level-supervisor-design.md`](docs/superpowers/specs/2026-11-24-router-two-level-supervisor-design.md)
（取代 11-16 轻量设计的角色/模板/工具三节）与 [`docs/requirements.md`](docs/requirements.md)。

## 门禁

本仓库的门禁是三条，全部绿才算过，缺一不可：

```sh
npm run typecheck   # tsc --noEmit（src 一遍、src+tests 一遍）
npm test            # vitest run（装载接线测试 + collaboration 单元测试 + sanity）
npm run build       # tsc -p tsconfig.json && tsdown
```

## 产物必须重建

`dist/entry.js`、`dist/tools.js`、`dist/context.js`（宿主入口产物）与 `lib/client.js`（浏览器产物）
**入库**，tsc 中间产物（`dist/client/`、`*.d.ts*`）不入库。改了 `src/` 之后光提交源码不够——宿主加载
的是 `dist/*.js`、页面加载的是 `lib/client.js`，**必须 `npm run build` 重建并把产物一起提交**，
否则本地看着改好了、装上去的还是旧产物，表现与「功能消失」一模一样。

构建要可复现：同一份源码必须得到同一份字节（tsdown 的 banner/footer/intro 固定、minify 确定序）。

## 装载接线（改 cordis.patch.yml / package.json 的 dsh 段前必读）

浏览器半边三条件，少一条就是「装上了却不生效、宿主日志一个字都没有」：

1. `package.json` 声明 `dsh.bundle.patch` 指向 `./cordis.patch.yml`；
2. `package.json` 声明 `dsh.client.platform = "web"`；
3. patch 里装载行的 **name 是裸包名** `@goodjin2/dsh-router`（不许带子路径）。

形状规矩：`exports["./client"]` 只能写字符串或 `{ "default": 字符串 }`；`lib/client.js` 是单文件 CJS
工厂（`window.__ModuleLoader__.load({ id, factory })`，顶层无 import/export）；`.` 入口指向宿主侧
入口 `dist/entry.js`，浏览器代码不进宿主进程。以上每条都有 `tests/bundle.spec.ts` 断言。

**预设 / 声明行改动后**（加行、换包、换名字），必须跑核查脚本，两个宿主都要绿。**候选核查必须用
候选工作区的绝对路径**——容器脚本按插件名在容器目录下找，会验到 main checkout 而不是本候选：

```sh
node scripts/check-subrows.mjs                         # 本仓子行 config 校验（双宿主，按候选 patch）
node scripts/check-collaboration-host.mjs "$(pwd)"    # 候选绝对路径宿主声明核查（双宿主）
node scripts/check-collaboration-client.mjs "$(pwd)"  # 候选浏览器半边激活预检
node /Users/good/github/dsh-plugins/scripts/check-host-rows.mjs dsh-router   # 容器：声明行 × 宿主版本
```

patch 现含：裸包名根服务行（`@goodjin2/dsh-router`）+ 独立工作台行（`@goodjin2/dsh-router/workbench`，
模块级必需 inject ['webServer','connection','routerCollaboration'] 挂四条协作 HTTP 路由
（/router/collaboration/{records,record,roles,models}），与工具行共享同一 RecordStore/RoleStore 单实例，
llm 可选注入、缺 llm 时 models 路由返回 unavailable:true）+ 一条静态「Router」预设行（`dsh-router`/`Router`，
persona `complete:true`，提示词来自 `collaborationPrompt` 单一来源）+ 九条协作工具行（含派发工具
`router_dispatch`：职责注入由代码完成，内部经 subagents 服务选 spawn/fork/continue，自动登记分工记录；
`taskId` 可选，省略即自动建任务；含压缩工具 `router_compact`：只压上次检查点以来的已闭合回合、原位取代成
任务列表检查点，走 `session.append(surfaceOp:replace)` 公开 API，**不自动压**）+ 协作上下文行（角色清单 + **活跃任务完整描述**注入）+ DSH 原生
执行/用户提问/项目指令/默认压缩/子代理控制（仅 `tool-subagent-control`；原生 spawn 工具行已删，
防绕过职责注入；spawn/fork 后端由 base 全局提供）。
**压缩不走宿主摘要器**：宿主 `compactNow` 是累积的（每次从 surface 头重选、合并 PRIOR checkpoint），摘要器
指令写死无注入口——做不出「只压上次以来」「任务列表」。`router_compact` 自己选范围、从记录生成检查点、
按压缩事务协议写 `compaction/start → user/message(replace) → compaction/end`；它 import
`@deepseek-ai/dsh-compaction`、`/checkpoint`、`@deepseek-ai/dsh-llm`（宿主侧，build 外置、devDeps 只为类型）。
Router 预设为静态行（id `dsh-router`），不再运行时动态注册；旧 supervisor/worker/executor
预设与旧动态服务已退役，不恢复。角色模板是一个角色一个 md 文件（文件名=角色名、正文=职责说明），
首次启用幂等种入 15 个预置角色（v3：「主管」退役，其余专业角色职责为「首行摘要 + 详细正文」
两层结构——上下文清单只注入首行摘要，全文随派发注入）、历史预置文本精确升级（内容与某版
历史文本一致才覆盖，用户改过的永不动）、**退役预置角色精确删除**（`RETIRED_PRESET_ROLES`：内容
等于任一版历史文本才删，用户改过的保留）、旧 JSON 自动迁移。改行先跑核查再提交。

## 工作方式

- 要改代码就在本仓开 worktree（`git worktree add .worktrees/<分支名> -b <分支名>`）再动手；主干
  （main）只收验证过的合并结果，随时可构建、可安装。
- 合并回 main 前以门禁为准：三项全绿再合；合并后重建产物并提交。
- 本仓不建 GitHub 远程时，验证走桌面版本地 link（改完即生效，但产物要重建）；要验「从 GitHub 安装」
  就先提交推送再走 web 版安装流程。

## 排障提示

- 「装上了却不生效」：先看宿主启动 stderr 的装配审计（`dsh: warning: N entry did not activate`），
  再看下发首页 HTML 的 `window.__DSH_BOOT__` 里有没有本包；浏览器控制台应能看到
  `[ @goodjin2/dsh-router] Router client loaded …` 自报行。
- 浏览器半边激活失败同样安静（fiber 吞异常、web boot 只报一行 `entry did not activate`）：预检见
  `scripts/check-collaboration-client.mjs`，三条纪律是 apply 全体包 try/catch 不穿透、inject 覆盖
  apply 读到的每个服务、降级路径不用 `process.stderr`。详见容器级规范 `../AGENTS.md`。
- 声明行静默失败的机制、升级后的核查规范：见容器级规范 `../AGENTS.md`（DSH 升级后的升级检查规范）
  与官方文档镜像 `../docs/official/`。
