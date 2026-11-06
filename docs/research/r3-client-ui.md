# DSH 浏览器半边（client 插件）UI 契约调研报告

调研日期：2026-11-07。只读调研，未修改任何文件（仅在 /tmp 写了 asar 读取脚本与本报告）。

路径约定：
- **[asar]** = `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内的 `dsh/node_modules/@deepseek-ai/…`（桌面版 0.2.2-rc.1 实际装载的构建产物；行号是该文件内的真实行号）。asar 是归档，我用只读脚本按头部偏移直接读取，未经解包改写。
- **[src]** = `/Users/good/github/dsh-plugins/…`（现成插件源码，真实可运行）。
- **[doc]** = `/Users/good/github/dsh-plugins/docs/official/…`（官方文档镜像，dsh-v0.2.2-rc.1）。
- 生成目录里每条 slot 还带 `source:` 字段指向源码仓原始位置（如 `packages/client/ui-layout/src/client/index.ts:107`），下文标为「源码锚点」。

最重要的一个事实先说：**完整 slot 目录在生成产物 `@deepseek-ai/dsh-cordis-client-runner/lib/client.js` 里以 `CLIENT_SLOT_API` 数组内嵌**（[asar] cordis-client-runner/lib/client.js:2606 起，`SLOT_CATALOG` 构建于 :7705，共 **109 个 slot key**）。每条带 kind（cardinality）、scope、summary、registerOptions、standardProps、declaredBy、occupants（当前占用者）、replaceRisk（替换风险）、example、source。官方文档 [doc] reference/subsystems/slots.md:191 明确说该目录由 `pnpm run gen-client-catalog` 依据 `SlotMap` 声明与 `slots.register()` 调用点生成，运行中可用 `cordis_inspect what:"client"` 查实时树。

---

## 1. 完整 slot 目录（与目标区域相关的全部 key）

### 1.0 cardinality 与 scope 的语义（[doc] slots.md:50-58）

| cardinality | 含义 |
|---|---|
| `single` | 单个 cell，渲染 priority 胜者；**已有占用者时注册＝替换（遮蔽自带 UI）** |
| `list` | cell 由必填 `id` 定址，按 `order` 升序排列；**新 id＝纯增量** |
| `keyed` | owner 传 `entryKey`，渲染匹配 key 的 cell；**已占用 key＝替换** |
| `chain` | 每个 entry 提供纯 `select(owner)`，第一个非 null 获选；全部拒绝渲染 owner fallback |

scope：`root`（无 Session 绑定）/ `session-maybe`（可选绑定）/ `session`（必须有绑定，组件收到确定存在的 `sessionId`/`useSession` 等）。

### 1.1 左侧栏（`sidebar*`）——结论：**项目/会话列表本体没有任何可注入 slot**

| key | kind | scope | 占用者（occupants） | replaceRisk | 证据 |
|---|---|---|---|---|---|
| `sidebar` | single | root | client-ui-sidebar SidebarRoot | **shadows-shipped-ui** | [asar] cordis-client-runner/lib/client.js:6050-6077（"注册这里＝整个换掉导航列，内层座位随之消失；要加东西请用内层座位"；源码锚点 packages/client/ui-layout/src/client/index.ts:70） |
| `sidebar.brand.mark` / `sidebar.brand.name` | single | root | 空 / 空 | — / — | :6080 / :6110 |
| `sidebar.panellist` | list | root | PluginsPanelIcon、TaskManagerIcon | **none** | :6228-6274（"全局面板图标：每个 list id 对应一个 main 面板，sidebar 拥有按钮并从 list 元数据解析标签"；源码锚点 ui-sidebar/src/client/contract/slots.ts:36） |
| `sidebar.panellist.actions` | list | root | — | none | :6277 |
| `sidebar.workspaces` | single | root | client-ui-workspace **WorkspaceBrowser**（项目+会话浏览区：分区头、搜索、分组/扁平会话列表、全部工作区对话框） | **shadows-shipped-ui** | :7155-7182（源码锚点 ui-sidebar/src/client/contract/slots.ts:45） |
| `sidebar.workspaces.directoryFlow` | single | root | Browse/Native 目录选择器 | shadows | :7185-7212 |
| `sidebar.workspaces.session.menu.item` | list | root | **空**（遗留外部会话菜单行，渲染在内建 Archive 之前） | none | :7215-7261（源码锚点 ui-workspace/src/client/contract/slots.ts:193） |
| `sidebar.workspaces.session.row.action` | list | root | archive(100)、pin(200)——会话行尾悬停按钮（"..." 之后） | none | :7264-7310（owner props：`sessionId`+`displayTitle`；源码锚点 ui-workspace slots.ts:212） |
| `sidebar.session.row.hover` | list | root | schedule-tasks、forge-panel.row（悬停卡片中段时间与尾行之间） | none | :6948-6994 |
| `sidebar.session.row.leading` | list | root | schedule-mark、liveshare.fork（标题前 16px 状态点格） | none | :6997-7044 |
| `sidebar.session.row.trailing` | list | root | forge-panel.row（时间标签后、置顶标前） | none | :7046-7092 |
| `sidebar.footer.action` | list | root | client-ui-cordis CordisPanel id 'cordis-panel'——**侧栏底部 Settings 旁的动作位** | none | :6179-6226（源码锚点 ui-sidebar slots.ts:56） |
| `sidebar.settings` | single | root | SettingsRoot | shadows | :7095-7123 |
| `sidebar.toggle.badge` | single | root | DesktopUpdateBadge | shadows | :7125-7153 |
| `sidebar.chat.conversation` | single | session | ConversationSlotPanel（右栏 chat 标签宿主的会话体） | shadows | :6140-6177 |

**判定**：分区头/搜索/会话列表全部封装在 WorkspaceBrowser 一个 single 占用者里（:7158），目录里不存在「工作区分区头」「新建项目/新建会话按钮」这样的注入点。**左侧栏的增量入口只有**：`sidebar.panellist`（图标→main 面板）、`sidebar.footer.action`（底部动作）、各 session-row 装饰/动作 list、`sidebar.workspaces.session.menu.item`（行菜单行）。

### 1.2 conversation.header 系列

| key | kind | scope | 占用者 | replaceRisk | 证据 |
|---|---|---|---|---|---|
| `conversation.header` | single | session-maybe | ConversationHeader（含无会话时的常驻导航容器） | shadows | :3364-3398（源码锚点 ui-conversation/src/client/contract/slots.ts:230） |
| **`conversation.header.leading`** | **single** | **root** | **空**（"会话标题之前的全局导航，无会话也可用"） | **none** | :3401-3428（源码锚点 ui-conversation slots.ts:259） |
| `conversation.session.header` | single | session | ConversationSessionHeader（每会话标题/动作/View 导航） | shadows | :4191-4227（slots.ts:232） |
| `conversation.session.header.actions` | list | session | agent-preset、job-list、subagent-catalog、agent-team | none | :4230-4290（slots.ts:247；"标题旁动作，溢出被裁切淡出，浮层必须 portal"） |
| `conversation.session.header.corner` | single | session | ExpandButton（最右角） | shadows | :4293-4330 |
| `conversation.session.header.lineage` | single | session | SubagentHeaderLineage（面包屑标题替换位） | shadows | :4332-4369 |
| `conversation.session.header.utilities` | list | session | open-in-app、schedule-catalog、forge-panel、liveshare-share、session-log-download（+ **chat-power 的会话 ID 条**） | none | :4371-4432 |
| `conversation.session.header.views.actions` | list | root | entry-customization（View 标签行 More 菜单的行；**列表无注册时宿主不显示 More**） | none | :4435-4482 |

DOM 锚点：leading 座位渲染在 `[data-conversation-header-leading]` 元素内——[asar] dsh-client-ui-conversation/lib/client.js:20643；`[data-conversation-content]`/`[data-conversation-session]` 在 :20602-20603；`[data-conversation-tabs]`（View 标签行）在 :20911。

### 1.3 conversation 顶部与 chat flow 前后

| key | kind | scope | 占用者 | replaceRisk | 证据 |
|---|---|---|---|---|---|
| `main` | keyed | root | ConversationPanel（key 'conversation'，保留）+ 其他面板 | shadows | :4758-4796（"按 sidebar entry id 选择中央面板"；源码锚点 ui-layout index.ts:75） |
| `main.conversation` | single | session-maybe | ConversationRoot | shadows | :4797-4832 |
| `conversation.session` | single | session | ConversationSession | shadows | :4152-4189（声明者是 **factory 'conversation.content'**） |
| `conversation.view` | list | session | chat(ChatView)、trajectory(TrajectoryView)、stats(StatsView)——**一次渲染一个 View** | none | :4580-4640 |
| `conversation.chat.flow` | single | session | ChatFlow（聊天行+本地 echo） | shadows | :2829-2870 |
| `conversation.chat.node` | keyed | session | 19 个 ChatNodeKind key（user/steering/assistant-step/tool-call/turn-tail/question-reply…） | shadows | :2915-2980 |
| `conversation.chat.turnTail` | list | session | （turn 尾动作行前的功能贡献，schedule 用它） | none | :3066-3127 |
| `conversation.chat.user.before` | chain | session | SharedSessionOrigin（用户气泡上方消息源装饰） | none | :3129-3171 |
| `workspace.toast` | keyed | root | （工作区通知，按业务判别符） | shadows | :7514-7560 |

### 1.4 composer / 输入区

| key | kind | scope | 占用者 | replaceRisk | 证据 |
|---|---|---|---|---|---|
| `conversation.composer` | chain | session | （选择器路由的**替换** composer；decline 落回宿主） | none | :3216-3267 |
| `conversation.composer.bar` | single | session-maybe | InputBar | shadows | :3269-3304 |
| `conversation.composer.dock` | list | session | activity、usage 官方胶囊（**acp-agent 配额胶囊也挂这**） | none | :3306-3362 |
| `conversation.input.dock` | list | session | queue、todo、goal、claude-code-mods、forge——**composer 卡片上方整行** | none | :3696-3758 |
| `conversation.input.left` | list | session | **空**（工具行左端紧凑控件） | none | :3760-3816 |
| `conversation.input.right` | list | session | **空**（提交动作前紧凑控件） | none | :4036-4092 |
| `conversation.input.overlay` | list | session | command-popup、slash-menu、feedback-dialog（composer 卡内浮层；**固定浮层必须 portal 到 document.body**） | none | :3896-3956 |
| `conversation.input.model` / `.model.label` / `.permission` / `.plan` / `.activity` / `.attachments` | single | session(或 maybe) | ModelSelect / 空 / PermissionSelect / PlanChip / VoiceInput / ComposerAttachments | shadows（label 除外） | :3818 / :3857 / :3958 / :3997 / :3616 / :3655 |

### 1.5 hero 区（空白会话首屏）

| key | kind | scope | 占用者 | replaceRisk | 证据 |
|---|---|---|---|---|---|
| `conversation.hero.brand.mark` | single | root | **空**（空白会话标题前的品牌标） | **none** | :3468-3496 |
| `conversation.hero.options` | list | session | forge-panel.worktree（New Session 行右端紧凑选项，**仅有会话时渲染**） | none | :3498-3554 |
| `conversation.hero.workspace` | single | root | WorkspacePicker | shadows | :3556-3584 |
| `conversation.hero.workspace.directoryFlow` | single | root | Browse/Native | shadows | :3586-3614 |
| `conversation.hero.agentPreset` | single | session-maybe | AgentPresetSeat | shadows | :3431-3466 |

**判定**：hero 可注入点 = `brand.mark`（single 但当前空）与 `options`（list，增量）。

### 1.6 root / 全局层

| key | kind | scope | 占用者 | replaceRisk | 证据 |
|---|---|---|---|---|---|
| `root` | single | root | client-ui-layout AppFrame（**唯一内建 slot，运行时自己渲染**；"DO NOT register here"） | shadows | :5311-5339（源码锚点 ui-renderer/src/client/registry.ts:44） |
| **`shell.overlay`** | **list** | **root** | 17 个占用者：QuotaNoticeHost、MenuOverlay、FileDragFeedback、OpenInAppToast、PluginRefreshToast、ScheduleDeleteToast、DesktopOnboardingEntry、AccountPlatformHost、HostReleasePrompt、UploadToast、ShortcutReference、SessionRenameDialog、SessionArchiveConfirmDialog、RowActionToast、forge/cua/session-log-export 的 toast 等 | **none** | :5948-6013（"frame 级浮层，高于所有列、在滚动容器之外；**刻意保持通用无 owner：badge、toast 栈、状态胶囊都归这**；层本身 click-through，占用者自行恢复 pointer events"——这是全局浮动层的标准答案；源码锚点 ui-layout index.ts:107） |
| `shell.bottom` | single | root | InspectorPage（三列之下整行，占高度） | shadows | :5888-5916 |
| `shell.leading` | single | root | HeaderLeadingControls（窗口 chrome 左上） | shadows | :5918-5946 |
| `shell.quota-notice` | chain | root | AccountQuotaNotice | none | :6015-6048 |
| `rightbar` / `rightbar.session` | single | root / session | RightbarRoot / — | shadows | :5242 / :5272 |

其余家族（settings.*、plugins.*、contextMenu.*、deliverables.*、tool.call.*、sidebar.right.*）见 1.7 与第 6 节。

### 1.7 settings 家族（与第 6 节互参）

| key | kind | scope | 占用者 | replaceRisk | 证据 |
|---|---|---|---|---|---|
| **`settings.section`** | list | root | agent-presets、account、general、models、plugins——**一个 entry 一整页设置** | none | :5754-5806（源码锚点 ui-settings/src/client/contract/slots.ts:57；owner props 里带 `close`，供"离开设置"的流程用） |
| `settings.section.icon` | list | root | — | none | :5809 |
| `settings.general.item` | list | root | （General 页里的一行偏好，"不需要整页的单一设置"） | none | :5420-5480 |
| `settings.header` / `settings.launcher` / `settings.trigger` | single | root | HeaderContent / AccountMenu / TriggerContent | shadows | :5482 / :5512 / :5858 |
| `settings.action` / `settings.close` | list / — | root | （内容列头部 Close 前的动作） | none | :5341 / :5390 |
| `settings.models.footer/provider-card/sign-in`、`settings.onboarding`、`settings.plugins.tab` | list/single | root | — | none | :5542 / :5591 / :5626 / :5656 / :5705 |

---

## 2. dsh-chat-power 的工具标签条是怎么插进去的 [src] /Users/good/github/dsh-plugins/dsh-chat-power/

三层机制，全部有源码行号：

**第 1 层：shell.overlay 挂一个「私有 slot 树」的宿主组件**（src/conversation-tools.tsx:254-256）：

```ts
ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'chat-power-tools-portal',
  children: { 'chat-power.tools': { kind: 'single', scope: 'session' } },
}, PortalRoot))
```

它用 shell.overlay（list、增量、frame 级浮层）取得一个**随时存活的渲染位**，再通过 `children` 声明自己的私有座位 `chat-power.tools`（single、session）及其子座位（conversation-tools.tsx:258-263：`chat-power.tools.sidebar.right.pane.tab` keyed、`.title` keyed 等，即 slot-names.ts:6-9 的 `sidebar.right.x → chat-power.tools.x` 改名映射，避免与宿主右侧栏撞名）。ToolArea（:128-146）用 `props.renderSlot(BODY, {}, { entryKey: definition.id, hookContext: () => info })` 渲染 keyed 子座位。

**第 2 层：DOM 位置**——PortalRoot 不满足于浮层坐标，而是用 MutationObserver 把一个真实 DOM 节点插进会话布局（conversation-tools.tsx:148-157）：

- 找 `[data-conversation-header-leading]`（宿主 header 的 leading 座位元素），向上 `closest('header').parentElement`，再向上直到根里含有 `[data-conversation-content]`；
- `root.insertBefore(body, content)`——**条带 DOM 位置 = 会话头部之下、会话内容之上**；
- 然后经 `createPortal(...)` 把 React 内容投进这个 div（:251）：`<props.SessionProvider session={reference.ref}>{props.renderSlot(ROOT, {})}</props.SessionProvider>`。SessionProvider 是「声明了 session scope children 的 root 组件」收到的框架 prop——官方定义 [asar] cordis-client-runner/lib/client.js:2349-2350（SessionProviderComponent），语义见 [doc] slots.md:77（不传 session 时继承外围绑定，传 SessionReference 时只覆盖该子树）。
- MutationObserver 回调末尾 `observer.takeRecords()` 吞掉自己造成的记录，防止自触发死循环（conversation-tools.tsx:158-166 注释，2026-11-07 空转现场）。

**第 3 层：标签行挂进宿主 View 标签行**（src/tools-tabs.ts:7-14, 128-152）：在宿主渲染的 `[data-conversation-tabs]`（role=tablist）里补挂自己的标签；宿主行找不到时自建 `[data-chat-tools-row]` 兜底行（:133-137）。头部两个入口按钮走的是正经 slot：`conversation.session.header.actions`（conversation-tools.tsx:311-315，`inject: (sessionId) => ({ sessionId })`）。

**生命周期**：`registerConversationTools(ctx)` 由客户端入口 apply 调用（src/index.ts:79-83，整块 try/catch，失败只损失工具区）；`ctx.slots.inject` 的 effect 跟随声明生命周期（[doc] slots.md:19：owner 折叠时 effect 移除，再挂载时重跑）；MutationObserver/条带清理在组件 unmount 里（conversation-tools.tsx:166-168）。每会话标签状态由自建 store 管理（src/tools-state.ts:25-68：`ToolsState` Map<sessionId, {active, tabs}> + subscribe/get/select/open/activateChat）。

**对「会话导航标签条」的冲突判定**：chat-power **已经占住了**「头部之下、内容之上」这一 DOM 位置（插入 `div[data-chat-tools-mount]`），并且它收/放消息时还用 MutationObserver 隐藏聊天节点（conversation-tools.tsx:203-246）。再往同一个 parent 插第二个条带会与它的 observer 互相触发、并与其布局切换（隐藏消息/flex 调整）打架。**最不冲突的集成点是 slot `conversation.header.leading`**（root scope、当前零占用、replaceRisk none，渲染位置就在 header 内 `[data-conversation-header-leading]` 里，同区域但完全走 slot 机制，不做 DOM 手术）。若必须做成内容区上方的整行，退而用 `conversation.input.dock`（list、session scope、composer 卡上方整行，官方占用者 queue/todo/goal 即此形态）。

---

## 3. client 插件 → 宿主插件服务的两种通信模式

### 3a. 宿主插件注册 HTTP 路由（webServer + connection.admit）

**宿主侧注册**（chat-power 的 mermaid 资产路由）[src] dsh-chat-power/src/mermaid-asset.ts:
- :26-28 `export const inject = ['webServer', 'connection']`；
- :38-40 路由常量 `export const MERMAID_ROUTE_PATH = '/chat-power/mermaid.js'`；
- :51-56 期望的宿主面：`webServer.register(route: { kind: 'exact'; path: string; handler(request, response): void|Promise<void> })`、`connection.admit(request): { rejection } | { peer }`；
- :80-114 `apply(ctx)` → `ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: MERMAID_ROUTE_PATH, ... handler 里先 `ctx.connection.admit(req)` 做同一登录准入，再回字节+ETag }))`（ctx.effect 保证插件卸载时路由随之注销）。

装载行写法（子路径导出行＝宿主行）[src] dsh-chat-power/cordis.patch.yml:15-19：

```yaml
- insert:
    - id: chat-power-client
      name: '@goodjin2/dsh-chat-power'          # 浏览器行：裸包名
    - id: chat-power-mermaid-asset
      name: '@goodjin2/dsh-chat-power/mermaid-asset'   # 宿主行：子路径导出（exports["./mermaid-asset"]，package.json:24-27）
    - id: chat-power-workspace-write
      name: '@goodjin2/dsh-chat-power/workspace-write' # 写回路由 /chat-power/workspace-file 同款
```

另一个同构样例：[src] dsh-acp-agent/src/zcode-quota.ts:23-24 `export const inject = ['webServer', 'connection']`（配额路由 `/acp-agent/zcode/quota`，注释 :10 "准入与官方 /api 同一面（照抄 peers 路由的写法）：connection.admit(req)"）。

**client 侧 fetch**：同源相对路径普通 fetch。[src] dsh-acp-agent/src/client/quota-pill.ts:312-337：

```ts
const response = await fetchImpl(routePath, { headers: { accept: 'application/json' } })
body = await response.json()   // 约定 { ok: true, quota } / { ok: false, error }
```

chat-power 的 mermaid 是 `<script src>` 注入、按 `<base href>` 解析成网关子路径（src/mermaid.ts:11-13 注释：同源主机网关会在被框页面里注入 `/threadharbor/gateway/<主机>/`，根绝对路径会绕过它）。

### 3b. Cordis @Remote 方法被 client 调用（api-remotes）

- 机制：宿主业务 service 用 Typert Remote decorator 标记方法；client 侧 **api-remotes assembly** 把方法挂到 `ctx.remote.<namespace>` 与 Session scope 的 `agentCtx.remote.<namespace>`（[doc] reference/subsystems/web-client.md:28）。`remote`、`remote.commands`、`remote.session`、`remote.subagents` 等是 client 图里的**独立可注入服务名**（[asar] dsh-api-session-controller/lib/client.js:4265-4273 的 inject 列表可证：session-controller 的 client 模块自己就注入这些名字）。
- **client 拿 scoped remote 的实际形态**：在 client 工厂的 inject 列表里声明 `'remote'`（root 面）或 `'remote.session'` / `'remote.workspaceFiles'` / `'remote.settings'`（scoped 面），然后 `ctx.remote.<namespace>.<method>(...)` 直接调——真实样例：
  - DeepSeek 余额（设置页同源 remote）[src] dsh-acp-agent/src/client/index.ts:46-50（`remote.account.getBalance` 类型面）+ quota-pill.ts:369-419：

    ```ts
    const getBalance = deps.remote?.account?.getBalance
    result = await getBalance.call(deps.remote, { version, locale, timezoneOffsetSeconds })
    ```
  - 定时任务建单 [asar] dsh-client-ui-schedule/lib/client.js:19378 `ctx.remote.schedule.create(request)`。
- **dsh-acp-agent 配额胶囊走哪条**：分两路——GLM/MiniMax/Codex/Claude/Grok 走 **3a 路由**（每 provider 的 spec.routePath，quota-pill.ts:73-130 + routeQuotaFetcher :312），DeepSeek 官方账号余额走 **3b remote**（quota-pill.ts:113-117 注释："设置页的余额是浏览器直接调 remote.account.getBalance 拿的，本包客户端注入的是同一个 @deepseek-ai/dsh-api-remotes，所以胶囊读同一个源、不碰令牌、不用新开后端"）。
- 事件回推：`ctx.remote.$on("api-session/status", ...)` 等转发事件（[asar] dsh-api-session-controller/lib/client.js:4282-4290；[doc] web-client.md:32）。

**选型**：要类型化 RPC/复用官方生成的远端 → @Remote（'remote' 注入 + namespace 方法）；要静态资源/临时 JSON 端点/不进 Typert 的东西 → webServer exact 路由 + connection.admit。

---

## 4. client 插件产物形态与可注入服务名

### 4.1 ModuleLoader factory 的确切结构

页面把 `exports["./client"]` 指向的文件当普通脚本加载，靠 `window.__ModuleLoader__.load({ id, factory })` 注册进懒 CJS 模块表（[asar] dsh-client-modules/README.zh.md:74 "协议是启动图——以 window.__DSH_BOOT__ 注入"、:92 "宿主向 <head> 注入 window.__ModuleLoader__ queue facade … 阻塞 parser 的 bootstrap combo 脚本"；执行 bundle 只注册 factory，模块主体在物化时才跑，:78）。官方模板（宿主自带）[asar] dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js:1-23：

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
        }, Decoration));
      },
    };
  },
});
```

即：**factory 必须返回 `{ inject: [...], apply(ctx) {...} }` 对象**（"plain function 没有声明位"，[asar] cordis-client-runner/lib/client.js:487）。产物不得有顶层 import/export（AGENTS.md「产物形状」节与 2026-11-03 现场同款判据）。

装载三条件（宿主源码可证）：
1. `package.json` 声明 `dsh.client.platform: "web"` —— [asar] dsh-client-modules/lib/index.js:789-790（`resolveMeta`：`decl.platform !== "web"` 直接 return null）；
2. `exports["./client"]` 为字符串或 `{ default: 字符串 }` —— :200-210（`clientExportOf`，其余形状当场抛错）；
3. **装载行 name 是裸包名** —— :818-819（`exactPackageSpecifier(loaderName)`；行名必须恰好解析出包名，子路径行不带浏览器半边）。另：`dsh.client.inject`（允许 require 的基座外包）与 `dsh.client.external`（精确请求）、`immediately` 一并读进 meta（:798-800）；包级声明见 [asar] dsh-client-modules/README.zh.md:34。

### 4.2 factory 的 inject 能请求哪些名字（'slots' 之外）

两个真实插件的完整 inject 列表：
- [src] dsh-chat-power/src/index.ts:40 `['slots', 'locale', 'remote', 'remote.session', 'remote.workspaceFiles', 'sidebarRight', 'uiSession']`
- [src] dsh-acp-agent/src/client/index.ts:56 `['slots', 'remote', 'remote.settings', 'remote.session', 'remote.workspaceFiles', 'uiConversation', 'uiWorkspace', 'sessions', 'locale']`

runner 内建/可见的服务面（[asar] cordis-client-runner/lib/client.js 的服务自述区）：`layout`（:1283-1325，`selectPanel/beginNavigation/toggleSidebar/openRightbar/closeRightbar`）、`locale`（:1326）、`sessions`（:1422-1516，ClientSessions 的 face：retain/using/retainInfo/refreshProjections/search/fork/scope/binding）、`slots`（:1518-1553）、`theme`（:1555）、`timer`（:1608-1642）、`uiWorkspace`（:1645-1768，见第 5 节）、`workspaces`（:1771 起，create/rename/delete…）。其他 client 模块提供：`uiSession`（[asar] dsh-client-ui-session/lib/client.js:800-806，adapter `{ current, bindingSource, renderArea }`，`current.getSnapshot().key`＝当前主视图会话 id）、`uiConversation`、`sidebarRight`、`remote`/`remote.*`（api-remotes assembly；scoped 名字存在的证据是上文 4265-4273 与真实插件 inject）。runtime 守卫原文：可用的是 "ctx.on / ctx.provide / timer helpers after injecting timer, and any service your returned plugin declared in inject (slots and theme are the usual UI seats)"（cordis-client-runner/lib/client.js:488）；`ctx.get(name)` 是无声明可选读取，直接 `ctx.serviceName` 访问则必须在 inject 里声明（:484-513）。

### 4.3 client 如何拿到 sessions/workspaces 的 client model

- `ctx.sessions` ← api-session-controller 的 client 模块在 root context 上提供：[asar] dsh-api-session-controller/lib/client.js:3856 `rootCtx.reflect.provide("sessions", this, void 0)`；语义 [doc] web-client.md:40-46（ClientSessions → SessionManager → Session）。
- `ctx.workspaces` ← WorkspaceController（Cordis Service 名字即 "workspaces"）：[asar] dsh-api-workspace-controller/lib/client.js:381-392（`class WorkspaceController extends Service { constructor(ctx, model){ super(ctx, "workspaces") … } }`，create :393 / initializeDefault :398 / rename :403 / delete :408）；语义 [doc] web-client.md:48-52。
- 组件内不拿 model，用标准 hooks `useSessions`/`useWorkspaces`（第 7 节）。

---

## 5. 程序化「打开/切换会话」与「在指定 workspace 新建会话」

归属：**`uiWorkspace` 客户端服务**（ui-workspace 的 UI 导航层；[doc] web-client.md:50 "ui-workspace 则提供 useWorkspaces 与导航回调"；服务自述 [asar] cordis-client-runner/lib/client.js:1645-1768）。不是 workspace model 命令、也不是 session-controller 命令——那两层只提供数据与 mutation（ctx.workspaces.create 等）。

| 动作 | 确切函数 | 证据 |
|---|---|---|
| 打开/切换到某会话 | `ctx.uiWorkspace.openSession(target: SessionTarget): void`（"Select a Session and show its Conversation as one UI navigation action"；target 也可以是持久 subagent 地址） | [asar] cordis-client-runner/lib/client.js:1650-1655 |
| 在指定 workspace 连接并打开（新建或复用空白） | `ctx.uiWorkspace.openWorkspace(workspaceId, beforeOpen?, options?: Pick<StartSessionOptions,'agentPreset'>): Promise<void>` | :1658-1675 |
| 解析/创建新会话（复用 listing 无 preset 的空白成员，否则新建） | `ctx.uiWorkspace.connectWorkspace(workspaceId, options?): Promise<SessionId>` | :1697-1706 |
| 「新建会话」动作（开到解析出的空白，可带 prompt/preset） | `ctx.uiWorkspace.startSession(workspaceId?, options?: StartSessionOptions): void`（workspaceId 缺省继承当前/最近工作区） | :1709-1717 |
| fork | `ctx.uiWorkspace.forkSession(sessionId, onCreated?, options?)` | :1678-1694 |
| 归档/取消归档 | `archiveSession` / `unarchiveSession` | :1720-1736 |

选项类型：`StartSessionOptions extends DraftInitializationOptions { agentPreset?: string }`（cordis-client-runner/lib/client.js:2446）；`DraftInitializationOptions { prompt?: string; clearPreviousDraft?: boolean; whenDraftExists?: 'replace'|'append'|'keep' }`（:2010）。**预设 id 支持（agentPreset）、初始 prompt 支持；会话标题参数 NOT FOUND**（已搜 StartSessionOptions/DraftInitializationOptions 全文，标题只能靠后续 rename 或继承）。

宿主自带 client 插件的真实调用样例：
- 切换会话：[asar] dsh-client-ui-schedule/lib/client.js:19299 `if (… === "available") ctx.uiWorkspace.openSession(id);`；dsh-client-ui-chat/lib/client.js:15529 `ctx.uiWorkspace.openSession(childId);`；dsh-client-ui-subagent/lib/client.js:1249 `ctx.uiWorkspace.openSession(address);`（子代理地址 target）；dsh-client-ui-workspace/lib/client.js:5811-5813 `const openSession = (sessionId) => { uiWorkspace.openSession(sessionId); }`。
- 新建会话（带 prompt）：[asar] dsh-client-ui-schedule/lib/client.js:19367-19372：
  ```js
  onNewTask: () => {
    ctx.uiWorkspace.startSession(void 0, { prompt: t("host.createPrompt"), whenDraftExists: "append" });
  },
  ```
  同款还有 dsh-client-ui-entry-customization/lib/client.js:188、dsh-client-ui-agent-preset/lib/client.js:3020。
- 会话列表数据源：`ctx.sessions.list.getSnapshot()`（schedule :19299 同行）或 slot 组件里的 `useSessions` 标准 prop。
- 当前选中会话：`ctx.get('uiSession').adapter.current`（subscribe + `getSnapshot().key`；[asar] dsh-client-ui-session/lib/client.js:800-806；chat-power 用法 [src] dsh-chat-power/src/conversation-tools.tsx:98-99 与 :241-242）。
- 辅助：`ctx.layout.selectPanel(panelId)`（cordis-client-runner/lib/client.js:1288）切中央面板。

---

## 6. 设置页：插件如何加一段

**slot key：`settings.section`**（list、root，"One settings page per list entry"，:5754-5806）。注册项 options：`id`（页面 key，驱动 only 过滤）、`order`（导航位置）、`label`（thunk，locale 变化时重注册即可）、可选 `locale` namespace 与 `inject` 私有面；owner props 里带 `close`（离开设置的流程用）。现成插件真实样例 [src] dsh-acp-agent/src/client/acp-visibility-panel.tsx:75-88：

```ts
slots.inject('settings.section', () => slots.register(
  { name: 'settings.section', id: ACP_VISIBILITY_PANEL_ID, order: ACP_VISIBILITY_PANEL_ORDER,
    label, locale: NAMESPACE, inject: () => face },
  AcpVisibilityPanel,
))
```

（调用点 src/client/index.ts:215-219。）小型的"只要一行偏好"用 `settings.general.item`（:5420-5480，"the additive seat for a single setting that needs no page of its own"）。官方 cook book（[doc] reference/cookbook/adding-a-settings-card.md）讲的是插件 Config 表单与 plugins.detail.*（badge/actions/section，行 ~44-60），并说明浏览器半边装载规则（"只把一个包的半侧挂在说明符恰为裸包名的那一行上"，行 ~62-75）。

---

## 7. React 渲染规则

- **标准 props 按 scope 自动给**（与来自哪个包无关）：[doc] slots.md:85-97 —— 所有 scope 都有 `useSessions`/`useSessionStatus`/`useSessionRetainInfo`/`useSessionAccess`、`useWorkspaces`/`useWorkspaceAccess`、`useRemoteAccess`、`usePanelInfo`；`session` scope 另有 `sessionId`、`useSession`、`useProjection`、`useAccess`、`useConversation`/`useInput`/`inputActions`、`useChat`、`useTrajectory`。生成目录里每个 key 的 `standardProps` 字段逐一列明（例如 [asar] cordis-client-runner/lib/client.js:5319-5330 root；:4257-4276 session.header.actions 多出 useChat/useConversation/useSession 等）。
- **组件输入的五个来源**：owner 值+标准 scope 值 / 注册项 `children` 授权的 renderSlot / 声明 `store` 的 useStore+actions / 注册项 `inject` factory 的私有面 / `locale` namespace 的 `t`（[doc] slots.md:66-79）。**组件绝不收到 ctx**（slots.md:79）。
- **声明 session scope children 的 root 组件会收到 `SessionProvider`**：不传 session 继承外围绑定，传 `SessionReference` 显式覆盖子树（slots.md:77；类型 [asar] cordis-client-runner/lib/client.js:2349-2350）。chat-power 的 PortalRoot 即此用法（conversation-tools.tsx:249-251）。
- **root 作用域注册全局浮层：可以，且就是 `shell.overlay`**——list、root、click-through、官方明言"additive seat for a frame-wide surface of your own"（:5951-5952），17 个现成占用者（:5991-6009）。chat-power 的工具门户、各类 toast/对话框全在这。
- **`ctx.slots.inject` 用法样例**：官方模板 [asar] dsh-agent-preset/.../templates/decoration/client.js:16-18；文档样例 [doc] slots.md:21-44（含组件从 `PropsRuntime<'conversation.session.header.actions'>` 推导 props 的写法）；session 座位的 inject 回调收到 `sessionId`（slots.md:104；chat-power session-id-bar [src] dsh-chat-power/src/session-id-bar/index.ts:214-231 `inject: (sessionId) => ({ sessionId })`；acp-agent 胶囊 [src] dsh-acp-agent/src/client/quota-pill.ts:707-727 `inject: (sessionId) => ({ visible, hooks: { zcodeQuota: poller, … } })`——hooks 里的裸 observable 被 renderer 转成 `useXxx(selector)` prop，slots.md:106）。
- 扩展规则（slots.md:195-202）：跨包只 `import type`；`single`/已占用 keyed ＝替换点，增量用新 list id 或新 keyed key。

---

## 8. 推荐接线方案（依据上述证据）

### 8.1 会话导航标签条（切换会话）

- **挂点：`conversation.header.leading`**（single、root scope、**当前零占用、replaceRisk none**，:3401-3428）。语义正是"会话标题之前的全局导航，无会话也可用"；渲染位置在 header 的 `[data-conversation-header-leading]` 内（ui-conversation/lib/client.js:20643），与 chat-power 工具条带同一区域但互不接触——chat-power 占的是 shell.overlay 的一个 entry + 自己插在 `[data-conversation-content]` 之前的独立 div（conversation-tools.tsx:148-157, 254-256），我们走 slot 就不碰它的 DOM、不进它的 observer 视野。组件收 root 标准 props（useSessions/useWorkspaces 等）。
- **数据**：当前会话 `ctx.get('uiSession').adapter.current`（subscribe/`getSnapshot().key`）；候选列表 `ctx.sessions.list`（或 useSessions）；条目元信息（标题/工作区/时间）从 sessions/workspaces snapshot 取。
- **切换动作：`ctx.uiWorkspace.openSession(id)`**（第 5 节，多处宿主插件在用）。新建走 `ctx.uiWorkspace.startSession(workspaceId?, { agentPreset?, prompt?, whenDraftExists? })`——**没有标题参数**。
- 备选：若要"内容区上方整行"形态，用 **`conversation.input.dock`**（list、session、增量，官方 queue/todo/goal 即整行 dock 形态，:3696-3758）；**不要**复制 chat-power 的 MutationObserver 插 DOM 方案（它已独占该插入点，注释里就有自触发死循环前科）。

### 8.2 浮动问题卡片

- **挂点：`shell.overlay`**（list、root、frame 级浮层、click-through、replaceRisk none，:5948-6013）。注册 `{ name: 'shell.overlay', id: '<自己的 id>', order: <大值靠前> }`；容器内自行定位（fixed），需要交互的元素恢复 pointer events（层本身 click-through 是官方设计）。
- **发送问题回宿主的两种模式**：
  - 发到**新会话**：`ctx.uiWorkspace.startSession(void 0 | workspaceId, { prompt, whenDraftExists: 'append' | 'replace' })`——纯 client 侧导航服务，无需任何后端（schedule 样例 client.js:19368-19371）。
  - 发到**当前会话**：卡片可像 chat-power 一样 `ctx.sessions.retain(id, { source })` 拿引用（conversation-tools.tsx:231-240），输入注入优先走宿主输入外壳 `ctx.get('conversation').input.shell(sessionId)`（chat-power 的引用通道，conversation-tools.tsx:34-37；不可达再退 execCommand）；或者问题经**自家 @Remote / HTTP 路由**交宿主插件处理后再投递。
  - 宿主插件若需提供数据（如问题模板、历史问题），按第 3 节选型：类型化数据 → `inject: ['remote']` 调 `ctx.remote.<ns>.<method>`；静态资源/轻端点 → 宿主子路径行 `webServer.register({kind:'exact'…})` + `connection.admit`，client 同源 fetch。

### 8.3 项目栏新建入口

- **NOT FOUND**：左侧栏项目/会话列表区域没有任何可注入 slot（全目录仅 :6050-7213 所列这些；`sidebar.workspaces` 是 single 且被 WorkspaceBrowser 占用，:7155-7182——注册它＝整个换掉浏览区，官方 doc 明言"要加东西请用内层座位" :6054，而内层座位里没有分区头/新建按钮位）。已搜位置：slot 目录 sidebar.* 全部 15 个 key、ui-workspace slots.ts 锚点（137/139/149/158/163/193/212）、ui-sidebar slots.ts 锚点（20/36/45/51/56）。
- **最接近的替代（按侵入度排序，均有证据）**：
  1. **`sidebar.footer.action`**（list、增量、位置就在侧栏底部 Settings 旁，:6179-6226）——放一枚"新建会话"图标按钮，点击 `ctx.uiWorkspace.startSession()`。轻、稳、零遮蔽。
  2. **`sidebar.panellist` 图标 + `main` keyed 面板**（:6228-6274 + :4758-4796）——官方"全局面板"模式（schedule 全套样例 [asar] dsh-client-ui-schedule/lib/client.js:19360-19393：`inject('main', () => register({ name:'main', key: PANEL_ID …}))` + `inject('sidebar.panellist', () => register({ name:'sidebar.panellist', id: PANEL_ID, order: 10 …}))`）。适合"新建入口"背后还有一张面板（预设选择、最近工作区）的重形态；面板内用 `ctx.layout.selectPanel` 回聊天（:1288）。
  3. 会话行级入口：`sidebar.workspaces.session.row.action`（:7264-7310，archive/pin 同款）与行菜单 `sidebar.workspaces.session.menu.item`（:7215-7261，当前零占用）。
- hero 区（空白会话首屏）的补充注入点：`conversation.hero.options`（list）与 `conversation.hero.brand.mark`（single、零占用，:3468-3496）。

### 8.4 设置段

- `settings.section`（第 6 节）：id/order/label + inject 私有面，参考 acp-visibility-panel.tsx:75-88；一行级偏好用 `settings.general.item`。

### 8.5 装载清单（防"装上不生效"）

新 client 插件必须同时满足（第 4.1 节）：package.json `dsh.bundle.patch` 行（宿主读 profile 用）+ `dsh.client.platform:"web"`（resolveMeta :790）+ `exports["./client"]` 字符串或 `{default}`（:200-210）+ patch 里**裸包名**浏览器行（:818）+ `lib/client.js` 为 `window.__ModuleLoader__.load({id, factory})` 单文件懒 CJS 工厂（官方模板 dsh-agent-preset/.../templates/decoration/client.js）。这些判定已有现成测试范式（AGENTS.md「给这类插件写一条装载接线的测试」节）。
