# dsh-router

DSH Router：**主管 / 工作型 worker 的会话任务编排插件**——把一个会话级任务拆给多个 worker、追踪进度、汇总结果。功能已实现（任务账本与派发、分叉创建 worker、身份卡、问答浮窗、通知卡片、失控防护、三层记忆、浮窗工作台、设置页）。**完整需求以 [`docs/requirements.md`](docs/requirements.md)（整合版）为唯一权威**；历次分版规格保留在 `docs/superpowers/specs/` 作历史决策记录。

> **开发与排障请先查官方文档**：本插件的宿主契约（装载行、客户端模块、Slots、路由等）
> 以 DeepSeek Harness 官方文档为准。本地镜像见
> [`../docs/official/README.md`](../docs/official/README.md)（含按场景的导航表），
> 线上版本见 <https://deepseek-harness.github.io/deepseek-harness/>。
> 排查「装上了不生效」「界面整块没反应」前先查对应章节。

## 现在装上会发生什么

- 预设选择器出现「Router」与主管/ worker 预设；picker 自建的 Router 会话被收编进工作台并幂等收到身份卡（Router 会话全部独立，不去重不跳转）。
- Router 会话里可派发任务（分叉创建 worker、继承历史与前缀缓存）、汇聚 worker 提问、收完成/异常卡片、作用域紧急暂停与解除冻结。
- 设置页出现「Router 管理」栏目（worker 类型 CRUD、Router 默认模型）；提示词编辑 UI 已移除（2026-11），既有提示词数据与宿主按角色默认保留。
- 浏览器控制台自报一行 `Router client loaded …`，让「装没装上」可查。

装载接线（声明行、产物形状、入口指向）由 `tests/bundle.spec.ts` 盯着，任何一条断掉测试就红，不会重演「装上但静默失效」。

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

配套的形状规矩：`exports["./client"]` 只能写字符串或 `{ "default": 字符串 }`；`lib/client.js` 必须是「单文件 CJS 工厂」（`window.__ModuleLoader__.load({ id, factory })` 包裹，顶层不得有 import/export）；`.` 入口指向宿主侧入口 `dist/entry.js`，浏览器代码不进宿主进程。以上全部有 `tests/bundle.spec.ts` 断言。

## 布局

```
src/entry.ts          宿主侧入口（组装 routerCore、问答桥、HTTP 路由、类型存储与动态预设）→ dist/entry.js
src/host/             账本 ledger / 调度与完成 core / 防护 guard / 会话桥 bridge /
                      收编索引 session / 记忆 memory / 上下文 context / 预设 presets / 工具 tools
src/client/           浏览器半边（工作台标签、问答/通知浮窗、返回按钮、设置段）→ lib/client.js
src/shared/           宿主/浏览器共享类型与视图契约
cordis.patch.yml      装载行（裸包名根服务行 + 主管/worker 两条静态预设行；Router 预设运行时动态注册）
tests/                装载接线、账本/状态机、防护、收编、记忆、客户端模型等全套测试
```

改任何声明行 / 预设行后必须跑容器核查脚本（双宿主都绿）：`node /Users/good/github/dsh-plugins/scripts/check-host-rows.mjs dsh-router`，以及本仓 `node scripts/check-subrows.mjs`。

## 记忆文档布局

三层记忆（`src/host/memory/`，需求 [`docs/requirements.md`](docs/requirements.md) §12）各是一份 Markdown，同一个形状：YAML 头 +「## 摘要」+「## 条目」。rootDir 由宿主集成层配置（默认插件状态目录）。

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
