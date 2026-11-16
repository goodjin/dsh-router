# dsh-router 仓库纪律

DSH Router：**由模型主导的团队协作插件**（Router 接任务、主管组队、成员执行；模型决策、DSH 通信、
插件保存资料）。归属映射：**会话任务编排（拆分、派发、追踪、汇总）→ 本仓 `dsh-router`**。
当前架构的唯一权威是轻量协作设计
[`docs/superpowers/specs/2026-11-16-router-lightweight-design.md`](docs/superpowers/specs/2026-11-16-router-lightweight-design.md)
与 [`docs/requirements.md`](docs/requirements.md)。

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

patch 现含：裸包名根服务行（`@goodjin2/dsh-router`）+ 一条静态「Router」预设行（`dsh-router`/`Router`，
persona `complete:true`，提示词来自 `collaborationPrompt` 单一来源）+ 七条协作工具行 + 协作上下文行 +
DSH 原生执行/用户提问/项目指令/默认压缩/子会话控制（`tool-subagent` provider spawn、toolName subagent、
maxDepth 2）。Router 预设运行时动态注册，不放 yml 以免同 id 相撞；旧 supervisor/worker/executor 预设
与旧动态服务已退役，不恢复。改行先跑核查再提交；动态注册行另过插件内注册校验。

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
