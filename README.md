# dsh-router

DSH Router：**由模型主导的团队协作插件**——一个 Router 入口接任务，Router 主会话**直接担任主管**
（两级模型，2026-11-24 起）：先拷问式对齐把模糊想法逼清，再用宿主原生子会话组建成员、分工、跟进、
汇审；模型决定拆分、派发、补做、汇总，用户决定最终交付是否满足要求。
DSH 管会话、通信、执行工具、持久化与宿主权限，插件只保存工作记录、提供协作规则、展示资料。

> **设计与需求权威**：两级模型设计见
> [`docs/superpowers/specs/2026-11-24-router-two-level-supervisor-design.md`](docs/superpowers/specs/2026-11-24-router-two-level-supervisor-design.md)
> （取代 11-16 轻量设计中的角色/模板/工具三节，其余章节仍有效）。
> 本 README 描述的是**当前两级设计**；`docs/requirements.md` 已同步为同一设计。
> 历史上的 executor/dynamic/aliases/三层记忆/状态机/收编等旧方案见 `docs/superpowers/specs/`
> 与 `docs/superpowers/plans/` 的历史决策记录，**旧用户数据与历史分支不删、不兼容、不迁移**。

> **开发与排障请先查官方文档**：本插件的宿主契约（子会话、模型、持久化、提示词组装）以
> DeepSeek Harness 官方文档为准。本地镜像见
> [`../docs/official/README.md`](../docs/official/README.md)，线上版本见
> <https://deepseek-harness.github.io/deepseek-harness/>。

## 设计要点

- **单一入口、两级模型**：用户只需一个 Router preset（`dsh-router` / 显示名 `Router`）。Router 主会话
  直接担任主管（「主管」角色已退役，不可派发）；成员不出现在 preset 列表，继承同一基础组合，靠每次
  派发消息里的初始任务说明明确角色。报告链：用户↔Router↔成员。
- **先对齐再分派**：Router 收到任务先做拷问式对齐（决策树 + 按轮前沿问题 + 推荐答案 + 事实自己查、
  决策留给用户），对齐到位才建主任务、才派发。
- **模型决策，DSH 通信**：创建/查询/发送消息/继续/停止直接用 DSH 原生子会话能力（`spawn`，
  `maxDepth=2`）。插件不建第二套通信系统、不做投递队列、不做业务授权矩阵。
- **每次派发可建任务并挂子会话**：`router_dispatch` 的 `taskId` 可选——给了在该任务下派发，省略则自动
  建任务（挂主任务下）；分工记录把子会话挂到任务上，追加需求时 `router_record_list` 查得到该发给谁，
  `mode=continue` 只投递并把追加要求拼进任务描述。
- **压缩由模型决定**：`router_compact` 工具只压「上一次压缩以来」的已闭合回合（当前轮不动、工具
  调用/结果不切开），原位取代成一份**任务列表检查点**（记录生成的任务列表 + 模型附的关键决策，不花
  一次模型调用）；行为规则引导何时压、压之前先把决策写进任务描述。不自动压。
- **任务描述驱动上下文**：活跃任务的完整描述每步注入系统上下文段（重渲染、原地替换、不进历史），
  写后零滞后刷新；压缩丢了细节，任务描述不丢。
- **角色是提示规则**：Router/主管/成员职责写进统一协作提示词（`complete:true`），不是安全边界，
  不修改系统提示词。
- **工作记录是共享资料**：任务说明、分工记录、工作报告、汇总记录各存一份独立 JSON，落在插件
  数据根的 `collaboration/` 下。模型/用户填写工作标签（待处理/进行中/受阻/已报告），插件**不
  从会话结束或退出码推断业务完成**。
- **保存与通知是独立动作**：保存失败原样返回工具错误，通知失败由模型决定下一步，插件不自动
  补偿、重派、验收、换人或恢复执行。
- **工作台只展示事实**：区分 DSH 运行事实、模型报告的工作描述、用户反馈三类信息；运行结束不
  改写业务标签，子会话状态不可取得显示「未知」。
- **单宿主写记录**：进程内串行、单文件原子替换；不支持多宿主共享目录与多文件事务。
- **旧数据不兼容**：新数据用 `collaboration/` 命名空间，不扫描、导入、接管旧会话或旧账本。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| 入口与规则 | `src/entry.ts` 装配一个 preset、统一协作提示词、七条记录工具、原生子会话工具、活跃任务视图缓存 |
| 工作记录 | `src/collaboration/{records,roles}.ts` 任务/分工/报告/角色模板的读写与会话关联 |
| 工作台 | `src/client/collaboration-{api,store}.ts`、`collaboration-panel.tsx`：列表/详情/报告/成果链接/会话跳转/模板编辑（只读任务资料） |
| DSH 接入 | `src/collaboration/{tools,context,routes,runtime}.ts` 用现有子会话工具、只读运行事实 |
| 两级模型新增 | `src/collaboration/dispatch.ts` 可选 taskId 自动建任务 + continue 泛化；`src/collaboration/active-tasks.ts` 活跃任务视图缓存；`src/collaboration/compact.ts` 模型主动压的 `router_compact` 工具（任务列表检查点，住 tools 行） |

第一版不新增：执行代理、SQLite 业务库、消息箱、预算熔断、任务图调度、自动修复服务、旧会话迁移、
业务授权引擎、独立投递状态机、自动成功判断、自动补做/换人、跨任务异步排空。

## 现在装上会发生什么

- 预设选择器出现「Router」一条可选预设；「主管」不再是可派发角色（已种入且未改过的 `主管.md` 会
  被自动删除，改过的保留）。
- Router 会话里提供七条协作工具（记录 CRUD + 角色模板）与原生子会话工具；上下文行说明当前
  会话 ID、协作目录与工具用法。
- 侧栏出现「协作工作台」入口：浏览任务资料、查看报告、跳转宿主会话、编辑角色模板；显示具体
  错误与重试，不把失败伪装成空列表。
- 浏览器控制台自报一行 `Router client loaded …`，让「装没装上」可查。

装载接线（声明行、产物形状、入口指向）由 `tests/bundle.spec.ts` 盯着，任何一条断掉测试就红。

## 安装挂载

桌面版 profile（`~/.dsh/profiles/desktop`）里两处各加一条：

- `package.json` 的 `dependencies`：`"@goodjin2/dsh-router": "link:<本仓路径>"`（本地验证用
  `link:`，key 必须与包名一致，否则会被 install 归一化改回去）；
- 同文件 `dsh.profile.bundles` 数组：加 `"@goodjin2/dsh-router"`（bundle id = 包名）。

然后 `pnpm install`，重开 DeepSeek Harness 生效。要验证「从 GitHub 安装」的完整流程，先把改动
提交并推送，再走 web 版按正常安装路径拉取。

## 开发命令

| 命令 | 做什么 |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit`：src 一遍、src+tests 一遍 |
| `npm test` | `vitest run`：装载接线测试 + 协作单元测试 + sanity |
| `npm run build` | `tsc -p tsconfig.json && tsdown`：产出 `dist/entry.js`、`dist/tools.js`、`dist/context.js`（宿主入口）与 `lib/client.js`（浏览器产物） |

门禁 = 三项全绿；产物入库，改了源码必须重建再提交（详见 [AGENTS.md](AGENTS.md)）。

## 浏览器半边三条件（改接线前必读）

带界面的插件有一半在浏览器里跑。「装上了不等于跑起来了」，三件事要同时成立，少一条就是
「界面没反应、也没有任何报错」：

1. **package.json 声明 `dsh.bundle.patch`** 指向本包的 `cordis.patch.yml`；
2. **package.json 声明 `dsh.client.platform = "web"`**；
3. **patch 里装载行的 name 是裸包名** `@goodjin2/dsh-router`——带子路径的行会退化成在 node 里
   import 浏览器产物，整块静默失效。

配套形状规矩：`exports["./client"]` 只能写字符串或 `{ "default": 字符串 }`；`lib/client.js`
必须是「单文件 CJS 工厂」（`window.__ModuleLoader__.load({ id, factory })` 包裹，顶层不得有
import/export）；`.` 入口指向宿主侧入口 `dist/entry.js`，浏览器代码不进宿主进程。以上全部有
`tests/bundle.spec.ts` 断言。

## 布局

```
src/entry.ts              宿主侧入口（装配单 preset + 协作记录服务 + 活跃任务缓存 + 路由 + 上下文/工具行）→ dist/entry.js
src/tools.ts              九条协作工具行（@goodjin2/dsh-router/tools）→ dist/tools.js
src/context.ts            协作上下文行（@goodjin2/dsh-router/context）→ dist/context.js
src/client/               浏览器半边（协作工作台面板 + 资料 API + 状态 store + ui-kit 基线）→ lib/client.js
src/collaboration/        两级协作核心：records/roles 存储、dispatch（可选 taskId / continue）、active-tasks、tools/prompt/context/runtime、routes
cordis.patch.yml          装载行（裸包名根服务行 + 一条静态 Router 预设行 + 原生执行/提问/指令/压缩/子会话工具行）
tests/                    collaboration/* 单元测试 + bundle/entry/tracked-install/preset-rows/validate-row 装载接线
scripts/                  check-subrows / check-collaboration-host / check-collaboration-client 候选核查
```

改任何声明行 / 预设行后必须跑核查脚本，两个宿主都要绿：

```sh
node /Users/good/github/dsh-plugins/scripts/check-host-rows.mjs dsh-router   # 容器：声明行 × 宿主版本
node scripts/check-subrows.mjs                                                 # 本仓：子行 config 校验（双宿主）
node scripts/check-collaboration-host.mjs "$(pwd)"                            # 候选绝对路径宿主声明核查（双宿主）
node scripts/check-collaboration-client.mjs "$(pwd)"                          # 候选浏览器半边激活预检
```
