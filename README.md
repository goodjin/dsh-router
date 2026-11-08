# dsh-router

DSH Router：**主管 / 工作型 worker 的会话任务编排插件**——把一个会话级任务拆给多个 worker、追踪进度、汇总结果。**开发中**：当前入库的是可构建骨架，浏览器半边只有一个占位的空 apply，装上后不会有任何可见功能。

> **开发与排障请先查官方文档**：本插件的宿主契约（装载行、客户端模块、Slots、路由等）
> 以 DeepSeek Harness 官方文档为准。本地镜像见
> [`../docs/official/README.md`](../docs/official/README.md)（含按场景的导航表），
> 线上版本见 <https://deepseek-harness.github.io/deepseek-harness/>。
> 排查「装上了不生效」「界面整块没反应」前先查对应章节。

## 现在装上会发生什么

什么都不会发生——这是刻意的。浏览器半边（`src/client/index.ts`）是 root 级别可运行的空 apply：不注册、不注入任何 slot，只在浏览器控制台自报一行 `client placeholder loaded`，让「装没装上」可查。宿主侧入口（`src/entry.ts`）同样只有 name 和空 apply。

骨架已保证的是**接线正确**：装载行的声明、产物形状、入口指向都有 `tests/bundle.spec.ts` 盯着，任何一条断掉测试就红，不会重演「装上但静默失效」。

## 安装挂载

桌面版 profile（`~/.dsh/profiles/desktop`）里两处各加一条：

- `package.json` 的 `dependencies`：`"@goodjin2/dsh-router": "link:<本仓路径>"`（本地验证用 `link:`，key 必须与包名一致，否则会被 install 归一化改回去）；
- 同文件 `dsh.profile.bundles` 数组：加 `"@goodjin2/dsh-router"`（bundle id = 包名）。

然后 `pnpm install`，重开 DeepSeek Harness 生效。要验证「从 GitHub 安装」的完整流程，先把改动提交并推送，再走 web 版按正常安装路径拉取。

## 开发命令

| 命令 | 做什么 |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit`：src 一遍、src+tests 一遍 |
| `npm test` | `vitest run`：装载接线测试 + sanity 测试 |
| `npm run build` | `tsc -p tsconfig.json && tsdown`：产出 `dist/entry.js`（宿主入口）与 `lib/client.js`（浏览器产物） |

门禁 = 三项全绿；产物入库，改了源码必须重建再提交（详见 [AGENTS.md](AGENTS.md)）。

## 浏览器半边三条件（改接线前必读）

带界面的插件有一半在浏览器里跑。「装上了不等于跑起来了」，三件事要同时成立，少一条就是「界面没反应、也没有任何报错」：

1. **package.json 声明 `dsh.bundle.patch`** 指向本包的 `cordis.patch.yml`；
2. **package.json 声明 `dsh.client.platform = "web"`**；
3. **patch 里装载行的 name 是裸包名** `@goodjin2/dsh-router`——带子路径的行会退化成在 node 里 import 浏览器产物，整块静默失效。

配套的形状规矩：`exports["./client"]` 只能写字符串或 `{ "default": 字符串 }`；`lib/client.js` 必须是「单文件 CJS 工厂」（`window.__ModuleLoader__.load({ id, factory })` 包裹，顶层不得有 import/export）；`.` 入口指向宿主侧空入口 `dist/entry.js`，浏览器代码不进宿主进程。以上全部有 `tests/bundle.spec.ts` 断言。

## 布局

```
src/entry.ts          宿主侧空入口（name + 空 apply）→ dist/entry.js
src/client/index.ts   浏览器半边占位（空 apply，不挂 slot）→ lib/client.js
cordis.patch.yml      装载行（现只有客户端一行；宿主路由/工具/预设行待契约研究后补）
tests/bundle.spec.ts  装载接线测试（dsh 段、裸包名行、产物形状、入口指向）
tests/entry.spec.ts   sanity 测试（两个入口源文件可加载、空跑不抛）
```

宿主路由 / 工具 / 预设行尚未接入，等契约研究返回后在 `cordis.patch.yml` 补行；补完必须跑容器核查脚本：`node /Users/good/github/dsh-plugins/scripts/check-host-rows.mjs dsh-router`。

## 记忆文档布局

三层记忆（`src/host/memory/`，规格 §6）各是一份 Markdown，同一个形状：YAML 头 +「## 摘要」+「## 条目」。rootDir 由宿主集成层配置（默认插件状态目录）。

| 层 | 文档 | 说明 |
| --- | --- | --- |
| 会话摘要 | `sessions/<sessionId>.md` | 头部记 `lastSummarizedSeq`（增量位）与 `title`；「## 摘要」存最近一次增量总结的条目化文本 |
| 项目记忆 | `project.md` | 项目约定、已确认事实、重要交付物 |
| 全局记忆 | `global.md` | 明确长期偏好、跨项目约定 |

条目（`## 条目` 节，追加式，锚点 `e1`、`e2`……单调递增）：

```text
- [决定] 条目正文（[决定]=用户决定 / [建议]=worker 建议 / [事实]=已验证事实）
  anchor: e1
  key: <主题>
  sources: <来源会话#消息范围>; …
  at: <写入时间>
  conflicts-with: e0    ← 同主题重复时指向旧条目锚（冲突保留不合成）
```

规则：结论带来源引用；三类分别标记；冲突保留不合成；增量位记录摘要已处理到的事件 seq（`summarizeIncremental` 只喂其后的事件，空增量跳过，llm 失败不推进）；正文去空白后不足 20 字符的条目拒绝写入（低信息门）。检索 `search(query, scope)`：关键词扫描（大小写不敏感、中文包含匹配、多词 AND），按条目写入时间倒序最多 20 条，`memoryRef` = `memory://<文档>#<锚>`。摘要用注入式 `llm.stream(messages, signal)`（宿主集成接 `ctx.llm.stream`，样板见 `docs/research/r2-sessions.md` §7.3），记忆模块不 import 任何宿主包。

## 运维：Router 收编的读取成本与诊断（v1.4）

v1.4 语义：Router 会话全部独立——不去重、不归档、不跳转；收编扫描只把 picker
自建的 Router 预设会话登记进工作台并幂等补发身份卡。判定源是受限会话头读取器
+ 持久化增量索引（`src/host/session/`），`/router/state` 轮询只消费增量候选，
稳态零副作用——2026-11-07 的「每轮全量重扫导致 OOM」现场已按此修复。运行边界、
扫描上限、失败冷却与 `GET /router/health` 诊断口径见
[`docs/router-adoption-operations.md`](docs/router-adoption-operations.md)
（核对日期 2026-11-08）。
