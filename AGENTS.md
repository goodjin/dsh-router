# dsh-router 仓库纪律

DSH Router：主管 / 工作型 worker 的会话任务编排插件（开发中，当前为可构建骨架）。
归属映射：**会话任务编排（任务的拆分、派发、追踪、汇总）→ 本仓 `dsh-router`**。

## 门禁

本仓库的门禁是三条，全部绿才算过，缺一不可：

```sh
npm run typecheck   # tsc --noEmit（src 一遍、src+tests 一遍）
npm test            # vitest run（装载接线测试 + sanity）
npm run build       # tsc -p tsconfig.json && tsdown
```

## 产物必须重建

`dist/entry.js`（宿主入口产物）与 `lib/client.js`（浏览器产物）**入库**，tsc 中间产物
（`dist/client/`、`*.d.ts*`）不入库。改了 `src/` 之后光提交源码不够——宿主加载的是
`dist/entry.js`、页面加载的是 `lib/client.js`，**必须 `npm run build` 重建并把产物
一起提交**，否则本地看着改好了、装上去的还是旧产物，表现与「功能消失」一模一样。

构建要可复现：同一份源码必须得到同一份字节（tsdown 的 banner/footer/intro 固定、
minify 确定序；将来接入 CSS 时照 chat-power 的「按基名算哈希、exports 键排序」纪律）。

## 装载接线（改 cordis.patch.yml / package.json 的 dsh 段前必读）

浏览器半边三条件，少一条就是「装上也不生效、宿主日志一个字都没有」：

1. `package.json` 声明 `dsh.bundle.patch` 指向 `./cordis.patch.yml`；
2. `package.json` 声明 `dsh.client.platform = "web"`；
3. patch 里装载行的 **name 是裸包名** `@goodjin2/dsh-router`（不许带子路径）。

形状规矩：`exports["./client"]` 只能写字符串或 `{ "default": 字符串 }`；`lib/client.js`
是单文件 CJS 工厂（`window.__ModuleLoader__.load({ id, factory })`，顶层无 import/export）；
`.` 入口指向宿主侧空入口 `dist/entry.js`，浏览器代码不进宿主进程。
以上每条都有 `tests/bundle.spec.ts` 断言，改接线先跑测试。

**预设 / 声明行改动后**（加行、换包、换名字），必须跑容器核查脚本，两个宿主都要绿：

```sh
node /Users/good/github/dsh-plugins/scripts/check-host-rows.mjs dsh-router
```

宿主路由 / 工具 / 预设行还没接（patch 里只有客户端装载行 + TODO 注释）；契约研究
返回后补行，补完先跑核查再提交。

## 工作方式

- 要改代码就在本仓开 worktree（`git worktree add .worktrees/<分支名> -b <分支名>`）
  再动手；主干（main）只收验证过的合并结果，随时可构建、可安装。
- 合并回 main 前以门禁为准：三项全绿再合；合并后重建产物并提交。
- 本仓不建 GitHub 远程时，验证走桌面版本地 link（改完即生效，但产物要重建）；
  要验「从 GitHub 安装」就先提交推送再走 web 版安装流程。

## 排障提示

- 「装上了却不生效」：先看宿主启动 stderr 的装配审计（`dsh: warning: N entry did
  not activate`），再看下发首页 HTML 的 `window.__DSH_BOOT__` 里有没有本包；
  浏览器控制台应能看到 `[ @goodjin2/dsh-router] client placeholder loaded` 自报行。
- 声明行静默失败的机制、升级后的核查规范：见容器级规范
  `../AGENTS.md`（DSH 升级后的升级检查规范）与官方文档镜像 `../docs/official/`。
