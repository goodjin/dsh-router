# DSH 插件宿主契约查证报告：代理预设声明 / 工具注册 / 斜杠命令 / 插件配置

- 核对版本：桌面版自带宿主 `dsh 0.2.2-rc.1`（各包 package.json 版本一致，如 `@deepseek-ai/dsh-web-app/package.json:59`）。
- 依据优先级：宿主实现 checkout（最高）→ 官方文档镜像（`/Users/good/github/dsh-plugins/docs/official/`，与 dsh-v0.2.2-rc.1 逐字节一致）→ 本地真实插件样本。
- 路径约定：`app.asar/dsh/…` 指 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/…`。asar 是单文件归档（未解包），本次用**只读**脚本按其头部索引逐文件读出（副本在 `/tmp/dsh-src/`，内容与归档内逐字节一致，行号即归档内文件行号）；原始文件零改动。
- 本报告全程未修改任何被研究对象（asar、docs/official、各插件仓库）。

---

## 0. 一个必须先纠正的前提：宿主并不加载 `preset/*.cordis.yml`

**结论：`preset/*.cordis.yml` 不是宿主约定，宿主没有任何按目录/glob 扫描 preset 文件的逻辑。NOT FOUND（已搜索：`dsh-app-boot/lib/index.js` 全文、`dsh/lib/profile-boot-e2mS45fC.js`、`cordis-plugin-loader/lib/index.js`、`dsh-plugin-manager/lib/index.js`，均无 `preset/` 目录或 glob 展开）。**

宿主加载声明行的唯一机制：

1. profile 的 `package.json` 里 `dsh.profile.bundles` 列出 bundle 包名；app-boot 按名解析包目录（`dsh-app-boot/lib/index.js:1769-1779` `resolveBundleDir`，两锚点：安装锚 → profile 目录）。
2. 读每个 bundle `package.json` 的 `dsh.bundle.patch`（**一个文件路径或有序文件路径列表，不做 glob 展开**）：`bundlePatchFiles`（`dsh-app-boot/lib/index.js:1335-1339`，非字符串/非字符串列表直接抛错 `dsh.bundle.patch must be a file path or a list of file paths`）；`bundlePatchPaths`（:1347-1349）。
3. 按「各 bundle 的 patch（按 bundles 顺序）→ profile 的 `cordis.patch.yml` → `--patch` 命令行 overlay → `$DSH_HOME/cordis.patch.yml`」叠 patch（:1308-1312 注释；`PROFILE_PATCH_FILENAME = "cordis.patch.yml"` :1327；profile 根文件 `PROFILE_ROOT_FILENAME = "cordis.yml"` 在 `dsh/lib/profile-boot-e2mS45fC.js:128`）。
4. bundle 的 `package.json` 没有 `dsh.bundle` → **整包跳过**，只在 stderr 打 `skipping profile bundle <包名>: <原因>`（`dsh-app-boot/lib/index.js:1351-1356` `reportSkippedBundles`）。

宿主自带的 preset 就是这么装的：`@deepseek-ai/dsh-web-app/package.json:46-56` 声明

```json
"dsh": { "bundle": { "patch": ["./cordis.patch.yml", "./presets/standard.patch.yml",
         "./presets/ptc.patch.yml", "./presets/minimal.patch.yml", "./presets/cordis.patch.yml"] } }
```

且 exports 暴露 `"./presets/*.patch.yml": "./presets/*.patch.yml"`（`dsh-web-app/package.json:26`）。

因此**所谓「preset 行」= 普通声明 yml 文件里的一条 `- insert:` 行，其 `name` 为 `@deepseek-ai/dsh-agent-preset`**。`dsh-superpowers/preset/agent.cordis.yml` 只是该插件自留的参考组合（其 `cordis.patch.yml:122,201` 注释明说「权威说明见 preset/agent.cordis.yml 的同名小节；此处与它逐字同步（scripts/test-preset-sync.mjs 看守）」），宿主不读它；宿主实际读的是 `dsh-superpowers/cordis.patch.yml`（其 `package.json` 只声明 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`）。`dsh-acp-agent` 连 `preset/` 目录都没有，七条 agent preset 行全部写在 `cordis.patch.yml`（:82 `acp-codex`、:250 `acp-claude` 等）。

---

## 1. 代理预设（agent preset）声明

### 1.1 声明行的完整结构

`@deepseek-ai/dsh-agent-preset` 的运行时 schema（`app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/lib/index.js:13-19`）：

```js
static inject = ["agentPresets"];                 // :10
static [EntryGroup.key] = true;                   // :12  保留子行 !!js 表达式，待子插件装载时求值
static Config = z.object({
    id: z.string().required(),                    // :14  preset 标识，必填
    name: z.string(),                             // :15  展示名，可选
    description: z.string(),                      // :16  展示说明，可选
    order: z.number(),                            // :17  花名册排序，可选
    plugins: z.array(z.any()).required()          // :18  子插件行列表，必填
});
```

装载动作：`[Service.init]` 里 `yield await this.ctx.agentPresets.register(this.config)`（:24-26）。README（`dsh-agent-preset/README.zh.md:40-48`）给出同款字段表，并注明：**声明行的 `id` 是 Loader 编辑地址；`config.id` 才是会话保存的 preset 标识符；子行可省略行 id 由 Loader 分配**（README.zh.md:48）。

宿主自带权威样例：`dsh-web-app/presets/standard.patch.yml:5-11`：

```yaml
- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins: [ … ]
```

### 1.2 子行（plugins 列表）的结构与校验

子行是 Loader 条目列表，校验在 `dsh-agent-preset-registry/lib/types/definition.js:6-28`（`entryListProblem`）：

- 必须是**顶层数组**，否则报 `the composition must be a top-level list of plugin rows`（:8-10）；
- 每行必须是 map 且有**非空字符串 `name`**，否则报 `row N names no plugin (a "name" string is required)`（:17-20）；
- `group: true` 的行，其 `config` 必须是嵌套行数组（递归校验，:21-25）。

子行可用字段（Loader 方言，证据见各处）：

| 字段 | 类型 | 语义 | 证据 |
| --- | --- | --- | --- |
| `id` | string | 行 id（Loader 编辑地址；settings 命名空间的名字） | standard.patch.yml:6；superpowers `lib/settings-schema.js:8-17` |
| `name` | string | 插件模块说明符：裸包名、`包名/子路径`、`cordis:group`、或相对文件路径 | standard.patch.yml:10,58；cordis-plugin-include |
| `config` | object | 传给插件 `apply(ctx, config)`，按插件导出的 `Config` schema 校验 | standard.patch.yml:11-13 |
| `disabled` | bool 或 `!!js` 表达式 | 行禁用；`!!js` 在装载时求值（如 `!!js process.platform === 'win32'`） | `cordis-plugin-loader/lib/index.js:473-477`；standard.patch.yml:22-23 |
| `group` | true | 组行；`name: cordis:group`；子行放 `config` 数组 | standard.patch.yml:57-60；`cordis-plugin-loader/lib/index.js:103-107` |
| `isolate` | map（服务名 → label/true） | 作用域隔离 realm：`true` = 条目私有 realm；同名 label 共享 | `cordis-plugin-loader/lib/index.js:596-710`；dsh-superpowers/cordis.patch.yml:1-10 注释 |

YAML 方言：`entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)`，`!!js` 标量物化为 `{ __jsExpr: "…" }`（`cordis-plugin-include/lib/index.js:388-394`）。

### 1.3 preset id：如何生成、如何暴露给客户端

id **不是生成的，是声明的**：`config.id`（1.1）。注册表 `AgentPresetRegistry`（服务名 `agentPresets`，`dsh-agent-preset-registry/lib/types/index.js:79`）：

- `register(definition)`：空 id 抛 `Preset id must not be empty`（:108-109）；重复 id 抛 `Duplicate agent preset: <id>`（:110-111）→ **重复 preset id 会让声明行装载失败**（`dsh-agent-preset/README.zh.md:84` 同文）。
- **暴露给客户端**：typert 远端方法（装饰器 `Remote('list'|'read'|'select')`，`dsh-agent-preset-registry/lib/types/index.js:58-60`），wire 名 `agentPresets/list`、`agentPresets/read`、`agentPresets/select`（生成物 `dsh-agent-preset-registry/lib/typert.remote-client.js:26-31` 起，`service: 'agentPresets'`）。花名册行结构：`{ id, name?, description?, order?, broken?, isDefault }`，按 `order` 升序、再按 id 字典序（`list()` :203-215；`remoteExportList()` :219-222，isDefault = id === defaultId）。`broken` 字段直接暴露激活失败原因（`diagnostic()` :163-175）。
- **客户端按 id 选 preset 建会话**：会话创建请求带 `agentPreset` 参数 → `dsh-api-session-controller/lib/index.js:237` `createMinted(request.cwd, await this.composeAgent(request.agentPreset))`；`composeAgent`（:264-276）先 `presets.resolve(presetId)`（省略时用默认；`resolve` 未知 id 抛 `agent-preset/not-found`，注册表 index.js:227-234），再在 Agent setup 里 `presets.mount(agentCtx, resolvedId)`（:276）→ `retain(id)`（:251-268）。会话恢复同路径（:308）。选择一经落盘以 `agent-preset/selected` 事件记入会话日志（index.js:382；转发 :87-90）。
- **默认 preset**：注册表行 `config.default`（必填，:68-71）+ 可被 Settings 覆盖的 `selectedDefault`（volatile，:70,93）。宿主基础组合挂的就是它：`dsh-web-app/cordis.patch.yml:590-593`：

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: standard
```

- **切换时机限制**：`select()` 只允许会话第一轮之前，已开轮次抛 `agent-preset/locked`（index.js:371-394，:375）。

### 1.4 preset 内如何设置系统提示词

系统提示词由 `systemPrompt` 注册表服务组装（服务名 `systemPrompt`，`dsh-system-prompt/lib/index.js:228`）。preset 内设提示词的键有三个层面：

1. **`@deepseek-ai/dsh-persona` 行（推荐路径）**。Config（`dsh-persona/lib/index.js:23-28`）：

   | 键 | 类型 | 默认 | 说明 |
   | --- | --- | --- | --- |
   | `prefix` | string | **必填** | 前置段文本 |
   | `suffix` | string | `""` | 后置段文本 |
   | `complete` | boolean | `false` | **整段替换**：该段成为唯一系统提示词段 |
   | `includeRuntimeContext` | boolean | `true` | 设 false 时 `suppressRuntimeContext()`（:47） |

   `apply` 注册 `PERSONA_PREFIX_SECTION`/`PERSONA_SUFFIX_SECTION` 两段（:35-46）；`complete: true` 时附加 `{ complete: true }`（:40）。该行是 **scope-only**：挂进 preset 就只遮蔽该会话的部署 persona；挂到全局会与注册表自带注册冲突而报错（模块注释 :4-16）。
   - **`complete` 段语义（存在且唯一）**：组装时统计 complete 段，多于一个抛 `multiple complete prompt sections are active: …`（`dsh-system-prompt/lib/index.js:383-384`）；有 complete 段时最终 `sections: [completeSection]`（:410）。官方文档同义：`docs/official/reference/subsystems/system-prompt.md:42`「一个有效的 `complete` 段会成为唯一的提示词段落」、:63-68（`complete?: boolean` JSDoc）。
   - 实例：`dsh-web-app/presets/minimal.patch.yml:14-18`（persona 带 `complete: true` 与 `includeRuntimeContext: false`）；superpowers 则不带 complete（与宿主各段拼合）。
2. **`{{model}}` 等变量插值**：段文本里的严格 `{{variable}}` 引用在组装时插值（`dsh-system-prompt/lib/index.js:111-120,176`）；`model` 变量由 agent loop 注册：`ctx.systemPrompt.variable("model", (context) => context.modelSelection?.model ?? context.agent?.options.model)`（`dsh-agent-loop/lib/index.js:1346`）。
3. **宿主面全局键**（不在 preset 行内）：`systemPrompt` 服务自身 Config `{ includeHarnessIdentity, includeRuntimeContext, personaPrefix, personaSuffix, toolOrder }`（`dsh-system-prompt/lib/index.js:216-222`）；`toolOrder` 只排序不裁剪，未注册名报错（:93）。preset 内任意行也可通过 `systemPrompt.section()` 贡献段（如 plan-mode 行的 `config.section`，standard.patch.yml:63-78 → `dsh-plan-mode`）。

### 1.5 preset 内如何限制可见工具清单

**工具注册是作用域分层的：preset 只挂它要的工具行，就是白名单。** 机制：

- `ToolsService`（服务名 `tools`）用 `ScopedLayers` 分层保存各 scope 的注册（`dsh-tools/lib/index.js:411-414,417-424`）；`view(scope)` 只汇总「全局层 + 该 scope 祖先链各层」的继承工具并施加限制，**本层自己的注册不受限制豁免**（:477-511）。
- preset 装载时，注册表把会话 scope 的 parent 绑到 preset 生成树的 key（`bindScopeParent`，`dsh-agent-preset-registry/lib/types/index.js:287-296`），于是只有 preset 树里挂的工具行 + 宿主全局工具对该 agent 可见。
- 显式遮罩 API：`ctx.tools.restrict({ allow?, deny? })`（`dsh-tools/lib/index.js:453-470`）——只作用于**继承来的全局工具**，多个限制取交集，本 scope 注册豁免；需要 scoped 上下文（`agent.ctx`），空过滤器、未知名、保留名 `run_code` 均抛错（:456-468）。官方文档：`docs/official/reference/subsystems/tools.md:163-174`、:534-535。
- 工具自身 config 开关也能裁剪（如 minimal.patch.yml:20-24 `tool-fs` 的 `read/write/edit: false`、standard.patch.yml:36-38 `applyPatch: false`）。
- preset 行**不得**向根 realm 泄漏服务，否则整树回滚（见 §5）；工具行只注册（副作用）、不 provide，所以无需 realm——superpowers/cordis.patch.yml:145-147 注释即此意。

### 1.6 preset 内模型/提供商如何配置

**preset 行本身没有「主会话模型」键**。主会话的 provider/model 来自会话的 model selection（`api-session-controller` 的 `installModelSelection(agentCtx)`，:266-276），persona 的 `{{model}}` 只是把它渲染进提示词。相关配置面：

- 默认路由：`@deepseek-ai/dsh-agent-default-model`，Config `{ provider: string required volatile, model: string required volatile, reasoningEffort?: string volatile }`（`dsh-agent-default-model/lib/index.js:21-24`）。
- preset 想带自己的模型清单/路由时的做法是**在 plugins 里挂一个自己的绑定插件行**，由它向模型选择注册表发布模型：样本 `dsh-acp-agent/cordis.patch.yml:82-250`（`acp-codex` preset → `acp-codex-binding` 行的 `config.models[]`（id/name/description）、`command`、`hideFromRoster` 等，均为该插件自有 Config，非宿主通用键）。
- 子代理默认路由可在 preset 内钉：`@deepseek-ai/dsh-tool-subagent` 行的 `config.agentOptions: { provider, model }`（superpowers/cordis.patch.yml:299-313）。

### 1.7 preset 行的装载时机与「修改只影响之后创建的 Agent」

声明随宿主启动读入 loader（§0/§5），注册表**立即激活**每条定义（`register → activate`，index.js:106-151）；官方 README：「声明会提前加载，修改只影响之后创建的 Agent」（`dsh-agent-preset/README.zh.md:12`）。改声明行后需重开宿主才生效（行是启动时读进 loader 的）。

---

## 2. 面向模型的工具注册

### 2.1 确切服务与方法

- 服务：**`tools`**（`ToolsService`，`super(ctx, "tools")`，`dsh-tools/lib/index.js:417`；`static inject = ["systemPrompt"]` :405）。插件行声明 `inject: ['tools']` 后在 `apply` 里调用 **`ctx.tools.register(definition, options?)`**（:433-445）。
- 其他方法：`restrict(filter)` :453、`get(name, scope?, toolSet?)` :520 起、`view(scope)` :477、`definitions(scope, toolSet)`、`schemas()` 投影（`projectToolSchema` :366-378）、executor 注册（每 scope 至多一个 :600）。`register` 返回的正是注销用的 disposer（:444，「the exact disposer that unregisters the tool」）——基于副作用注册，dispose 插件 fiber 即注销（cookbook :36）。
- 注册校验（:436-441）：`definition.output` 必须是 `{ schema, render, presentationMeta? }`（否则 `TypeError: tool "<name>" must declare output { schema, render, presentationMeta? }`）；`output.schema` 过 `assertSupportedJsonSchema`；`timeoutMs` 若给必须正有限数；**名字 `run_code` 保留**（:440）。
- `options`：`{ when }`（步时激活条件）。`definition` 上还可带 `deferLoading: true`（进模型可见 schema 投影，:366-378）。

### 2.2 ToolSchema / ToolDefinition 类型位置与字段

- **模型可见 schema 投影**：`projectToolSchema(definition, detachParameters)`（`dsh-tools/lib/index.js:366-378`）→ `{ name, description, parameters, deferLoading? }`；`parameters` 必须无损 JSON（否则抛 `tool "<name>" parameters must be lossless JSON before schema projection`，:372-373）。该投影经 `ctx.systemPrompt.tools(...)` 进入系统提示词组装（:421-424；`dsh-system-prompt/lib/index.js:371-381` structuredClone 后下发）。
- **单文件源**：类型约定集中在 `dsh-tools/lib/types/*.js`（JSDoc 版，含 `schema.js` 的 `defineTool`/`projectToolSchema` 与 `pipeline.js` 的执行流水线；包内 exports `"./pipeline"` 指向 `lib/pipeline.js`）。**本 checkout 的 asar 未随包发 `.d.ts`**（全树仅 16 个 d.ts，dsh-tools 没有；`exports` 里写的 `./lib/types/index.d.ts` 在包内缺文件），以 JSDoc 源为准。
- **作者 DSL**：`defineTool(options)`（`dsh-tools/lib/index.js:310-355`）：`parameters` 是「每属性一个 `{ type, required?, description?, enum?… }`」的对象 DSL，编译为对象根 JSON Schema（`parameterSchemaSpecToJsonSchema` :277-285）；`output.schema` 是值 schema DSL（`valueSchemaSpecToJsonSchema` :267-275）。编译后 `execute` 前**自动校验模型参数**，违规抛 `ToolArgsError`（:285-293，code `INVALID_ARGS`；`validateArgs` :300）。
- 也可绕过 `defineTool` 直接 `ctx.tools.register({...原始 JSON Schema 定义})`（此时输入校验归作者自责，cookbook :40 末句）。

### 2.3 exec 处理器签名

`execute(args, exec)`（`dsh-tools/lib/pipeline.js:471` `const returned = await tool.execute(exec.arguments, exec)`）：

- `args`：已校验/物化的只读参数（分发前冻结为分离无损 JSON，cookbook :42）。
- `exec`：不可变执行身份 + 调用方持有的 **必填 `signal`**。字段实证：`exec.agent`（Agent 或 undefined）、`exec.signal`（AbortSignal，`throwIfAborted()` 用法见 `dsh-tool-bash/lib/index.js:663-676`）、`exec.callId`、`exec.rootCallId`、`exec.token`（不透明令牌）、`exec.parent`（外层 PTC 传输令牌，仅身份）。权威清单：cookbook :42（「`callId`、`name`、`arguments`、`agent`、`token`、必填且由调用方持有的 `signal`，以及可选的外层传输 `parent` token 在整个分发过程中保持不可变」）；实参用法 `dsh-tool-bash/lib/index.js:348,370-373,426,442,663-676`。
- 只有 around-dispatch 包装层（`tools/execute`）可替换 `exec.signal` 施加截止时间，不能移除（cookbook :42；`docs/official/reference/subsystems/tools.md:180`）。
- **必须遵守 `exec.signal`**：信号触发取消进行中工作（cookbook :45）；宿主在进入 producer 前把已中止调用判为失败（:51）。
- 异步追加上下文：`exec.agent.inject({ content, source: { kind: '…' } })`（cookbook :47）。

### 2.4 返回值与错误约定

- **`execute` 返回规范 JSON 值**（`output.schema` 声明的形状，根可为对象/数组/标量/null，cookbook :43），**不要返回内容块**；注册表快照→校验→冻结后交给 `output.render(args, value)`，由 render 产出面向模型的内容块数组（官方教程：`docs/official/develop/basic/tool.md:23-26,34` `render: (_args, value) => [{ type: 'text', text: value }]`）。
- **抛异常或返回无效值 ⇒ 工具结果 `isError`**；基础设施故障抛异常，领域性「不理想但成功」写进规范值（cookbook :44）。
- 错误类型全在 `@deepseek-ai/dsh-tools`（`dsh-tools/lib/shared-DTdn5dXO.js:6,15,39,554,566,568,575,588`）：`ToolBatchExecutionError`、`ToolExecutorUnavailableError`、`JsonSchemaError`、`ToolActivationError`、`ToolNotFoundError`、`ToolOutputError`、`ToolArgsError`（lib/index.js:285）+ 常量 `TOOL_ABORTED = "ABORTED"`、`TOOL_ABORTED_BEFORE_DISPATCH`（:566,568）。PTC mode 下调用失败 reject 为 `ToolCallError`，程序只见 `name/toolName/message`（cookbook :63）。
- 策略扩展点：`tools/pre-execute`（allow/deny/ask waterfall）→ 单调 `ctx.tools.guard()` → `tools/execute` → `projectContent` → `tools/post-execute` → `finalizeContent` → `tools/result`（cookbook :59；`tools.md:180`）。
- 后台长任务：`ctx.jobs.start({ kind, label, owner: exec.agent, run })`，成功分支返回 `{ kind: 'background', jobId }` 类规范句柄；已发布任务取消归 `job_kill`/owner dispose，不再受 `exec.signal` 管（cookbook :51-53）。

### 2.5 preset/bundle 如何把预设可见工具限制为白名单

见 §1.5：组合级（preset 只挂白名单工具行，scope 链决定可见性，`dsh-tools/lib/index.js:477-511`）+ `ctx.tools.restrict({allow/deny})` 遮罩继承全局工具（:453-470；限制取交集、本层豁免）。无宿主级「preset 工具白名单配置键」（`ToolsService.Config` 只剩两个 `z.never()` 的已废键，:406-409）。

---

## 3. 斜杠命令注册

- 宿主服务：**`commands`**（`CommandRuntime`；包 `@deepseek-ai/dsh-commands`，服务名 `const name = "commands"`，`dsh-commands/lib/index.js:77`）。官方 README：`dsh-commands/README.zh.md:30-46`——`ctx.commands.register({ name, description, input?: { hint }, handler })`；处理器返回 `{ kind: 'success' | 'error', text? }`，直接作用于 agent、**不产生模型消息**；同名重复注册抛错（:46）；命令名必须小写 `[a-z0-9_-]`（:50）；`execute(agent, line, attachments, signal)` 分发、语法/名称不符返回 undefined（:62）；agent 作用域下注册的命令只遮蔽该 agent 的同名全局命令（:54）；取消语义（:68）。
- 处理器 invocation 还带 `attachments`（`input.attachments` 声明后接受 composer 图片/文件，README.zh.md:58）与可选 `definitionId` 品牌标识（:32）。
- **本地样本**（`/Users/good/github/dsh-plugins/dsh-command-commit-merge-push/src/index.ts`，全文 29 行）：

  - `src/index.ts:10-11`：`export const name = 'command-commit-merge-push'`；`export const inject = ['commands']`。
  - `src/index.ts:23-28`：`ctx.commands.register({ name: 'commit-merge-push', description: 'Commit, merge to main, and push', input: { hint: '[commit message]' }, handler: ({ rawInput }) => executeShip(rawInput ?? '') })`。
  - 挂载行：`cordis.patch.yml:10-12`：

    ```yaml
    - insert:
        - id: goodjin-commit-merge-push
          name: '@goodjin2/dsh-command-commit-merge-push'
    ```

- 命令在 preset 内挂（如 `@deepseek-ai/dsh-command-compact`、`command-goal`）同样以子行进入（standard.patch.yml:79,91-92；superpowers/cordis.patch.yml:193,252-253），对仅该 preset 的会话可见。
- 客户端半边不消费 presentCall/Result（无 UI 关系）；ACP/无 UI 部署没有命令面（`dsh-commands/README.zh.md:12`）。

---

## 4. 插件配置

### 4.1 声明 schema

插件导出 **`Config`**（Schemastery/Standard Schema 接口）+ `apply(ctx, config)`：`docs/official/develop/basic/config.md:7-43`。要点：不要导出普通对象当 Config（:43）；装载时校验，不合法即装载失败并给出明确错误（:72）；配置变更触发插件热替换（:98）。实例：`dsh-persona/lib/index.js:23-28`（`z.object`）、superpowers `lib/settings-schema.js:38-…`（`.required()`、volatile 规则注释）。

- **只有 `.volatile()` 字段能被 Settings 页编辑**：`settings.update` 拒绝写非 volatile 节点之下（"Config field … is not volatile"）；**volatile 字段里不能再嵌 volatile 字段**（superpowers `lib/settings-schema.js:31-40` 注释；`dsh-settings/lib/index.js:148-155` `isVolatilePath`）。
- 每个包的 config 键目录由生成器产出：`docs/official/reference/config-catalog.md:1-11`（`gen-config-catalog` 生成，`verify-config-catalog` 门禁；**运行时 schema 有意排除的字段是 runtime-only seam，不能从 cordis.yml 设置**，:5）。

### 4.2 运行时读取

- **自己的配置**：就是 `apply(ctx, config)` 入参（config.md:27-29）；Settings 改 volatile 后走插件热替换重载（config.md:98）。
- **跨行读别的行的即时配置（0.2.x 无 `settings.get()`）**：`const editor = ctx.get('configEditor')` → `editor.entries().find(row => row.options?.id === NAMESPACE)` → `entry.fiber.config`（volatile 字段物化为引用，用前 `unvolatile` 解引用）。实证：superpowers `lib/skill-delegation.js:83-87,164-173`（注释原文「DSH 0.2.x exposes no `settings.get()`」）；`dsh-config-editor/lib/index.js:20`（服务名 `configEditor`）、:30-31（`entries()`）。settings 命名空间名 = **Loader 行 id**，不是插件自选（superpowers `lib/settings-schema.js:8-17`：改行 id 会静默孤儿化已存值）。
- **写入（Settings 通道）**：`settings.update(ns, patch, expectedRevision?)`（`dsh-settings/lib/index.js:470`；superpowers `lib/index.js:60-63` 调用形）；带修订号防过期写（`dsh-settings/README.zh.md:7`「拒绝过期写入」）。

### 4.3 持久化位置

**Settings 的更改写回当前 profile 的 Cordis patch（`cordis.patch.yml`）**：`dsh-settings/README.zh.md:7`「更改通过当前 profile 的 Cordis patch 持久化」、:48「重置恢复 profile 覆盖层以下的值…Home patch 和命令行 overlay 优先级更高；表单写入若会被它们覆盖，则被拒绝」。即持久化文件是 `~/.dsh/profiles/<profile>/cordis.patch.yml`（profile patch 层），不是独立 settings 文件；旧版 `~/.dsh/settings.yaml` 仅启动时一次性导入并改名 `settings.yaml.imported`（README.zh.md:35）。普通（非 volatile）配置本来就在各声明行的 `config:` 里，也在 patch yml / profile 里。

---

## 5. 宿主启动装载 preset 行：loader 行语义与常见坑

### 5.1 启动链路

boot → 读 profile manifest（`dsh.profile.bundles`）→ 逐 bundle `dsh.bundle.patch` 读 patch 文件 → 叠加用户 patch 层 → `applyPatches`（insert/replace/remove 等 patch 操作）→ `prepareProfileEntries`（`dsh-app-boot/lib/index.js:3091`；在 :3186 被用于从 patches 得到行列表）→ 交给 Cordis Loader 组树直至 settle（:4328 注释「drive the Cordis Loader against a leaf cordis.yml until the tree settles」）。preset 行（`@deepseek-ai/dsh-agent-preset`）随宿主启动即 start，其 `Service.init` 立即把定义注册并激活（§1.3）。

### 5.2 never started

行导入失败/未激活的审计话术：**`<行 id> (<包名>): never started`** —— `dsh-agent-preset-registry/lib/types/mount.js:115-122`（`auditRows`：`entry.fiber === undefined` → push `` `${entry.options.id} (${entry.options.name}): never started` ``；fiber await 失败 → `${id} (${name}): ${detail}`；缺注入 → pending `waiting for …`）。宿主启动面审计：`dsh-app-boot/lib/index.js:5162` `` `${binName}: warning: ${n} … did not activate\n` `` + 每行 `inactiveDiagnostic`；required 行失败则是 `startup failed: N required plugins did not activate`（:5175）。

### 5.3 预设整树事务回滚的触发条件

preset 装载是**单事务**（`mountPreset`，`mount.js:183-198`）：`tree.root.update(...)` 建树 → `auditRows` → 两类失败**reject 整个 mount**：

1. 任一可用行失败（含 never started）：`throw new Error(audit.failed.join('\n'))`（:192-193）;
2. **根 realm 服务泄漏**：preset 树内 provide 的服务没裹 `isolate` realm、发布进了根 realm → `throw new Error('Preset services require isolate realms: <names>')`（:194-195；`leakedServices` :58-75 按符号表比对实现）。

失败后注册表 `activate` 捕获 → `record.broken` + `scope.dispose()`（**整棵树回滚**，`dsh-agent-preset-registry/lib/types/index.js:146-150`）→ 此后任何按该 id 建会话/选择在 `retain()` 处抛 `RemoteError('agent-preset/invalid', …)`（:263）——用户看到的是「这个 preset 建不出任何会话」。等待宿主服务的行不算失败（`diagnostic` 先等 host loader settle 再审计，:163-175；`mount.js:170-177` 注释）。行「等不到服务」只进 pending（`auditRows` :131-134）。

### 5.4 写预设行的常见坑

1. **命名空间包名必须加引号**：YAML 纯量不能以保留字符 `@` 开头。用宿主自带的 `yaml` 包实测：`name: @goodjin2/xxx` → `Plain value cannot start with reserved character @`（解析失败）；`name: '@goodjin2/xxx'` 正常。宿主自带 preset 一律引号（standard.patch.yml:7 等）。
2. **子路径导出被删会让整预设回滚**：行按 `name` 从宿主安装目录 import；`…/list-agents` 这类子路径行若宿主已把能力并进主包，该行 never started → 整树回滚 → `agent-preset/invalid`（现场注记：superpowers/cordis.patch.yml:281-286 注释，2026-11-06，dsh 0.2.2-rc.1）。声明行是启动时读入 loader 的，改完必须重开宿主。
3. **`!!js` 表达式**：disabled/路径等可用 `!!js`（`entryListSchema` 的 `__jsExpr`，cordis-plugin-include/lib/index.js:388-394）；字符串值里的引号嵌套注意 YAML 转义（如 superpowers/cordis.patch.yml:183 的 `!!js "…"` 长表达式）。
4. **preset 树内 provide 必须裹 isolate**，否则泄漏审计整树回滚（§5.3；`dsh-superpowers/cordis.patch.yml:21-26` 注释：「a preset row publishing into ROOT is exactly what the host's leak audit rolls the whole preset back for」）。工具行只注册不 provide，无需 realm。
5. **bundle 忘写 `dsh.bundle.patch`**：整层被跳过，只有一句 stderr `skipping profile bundle`（§0 第 4 条）——「装上了但什么都没发生」。
6. **重复 preset id / 空 id**：声明装载失败（§1.3）；settings 命名空间随行 id，改行 id 会孤儿化已存值（§4.2）。

---

## 6. import 说明符与导出符号清单（逐一）

> 本宿主的包名在 `@deepseek-ai/` 作用域后一律用**连字符**（源码 import 实证：`dsh-tools/lib/index.js:2-6`、`dsh-persona/lib/index.js:1-2`、`mount.js:2-5`）。

| import 说明符 | 导出符号 | 证据 |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `Service`（类装饰宿主服务基类）、`Context`（类型）、`Context.isolate`（realm 符号） | `dsh-agent-preset/lib/index.js:1`；`dsh-config-editor/lib/index.js:4`；官方教程 `develop/basic/tool.md:10`；`mount.js:2,60` |
| `@deepseek-ai/schemastery` | **default** 导出 `z`/`Schema`（schema 构建器：`.object/.string/.number/.boolean/.array/.union/.never/.required/.volatile/.default`） | `dsh-agent-preset/lib/index.js:3`；`dsh-persona/lib/index.js:1`；`develop/basic/config.md:11` |
| `@deepseek-ai/dsh-tools` | `defineTool`、`ToolsService`（别名 `ToolRuntime`、default）、`validateArgs`、`projectToolSchema`、`parameterSchemaSpecToJsonSchema`、`valueSchemaSpecToJsonSchema`、`assertObjectJsonSchema`、`assertSupportedJsonSchema`、`isJsonSchemaRecord`、`isPlainJsonArray`、`isPlainJsonRecord`、`JsonSchemaError`、`ToolArgsError`、`ToolNotFoundError`、`ToolOutputError`、`ToolActivationError`、`ToolBatchExecutionError`、`ToolExecutorUnavailableError`、`TOOL_ABORTED`（"ABORTED"）、`TOOL_ABORTED_BEFORE_DISPATCH`、`RUN_CODE_NAME` | 全量导出行 `dsh-tools/lib/index.js:665`；错误类定义 `lib/shared-DTdn5dXO.js:6-598`。子路径：`./presentation`、`./pipeline`（`dsh-tools/package.json` exports） |
| `@deepseek-ai/dsh-commands` | `CommandRuntime`（default）、`CommandId`、`CommandDefinitionId`、`parseCommand`、`name`（"commands"） | `dsh-commands/lib/index.js:478`；子路径 `./types ./brand ./typert ./remote ./builtin`（`dsh-commands/package.json` exports） |
| `@deepseek-ai/dsh-agent-preset` | default（`AgentPreset` 插件；行 `name` 写它即挂 preset 声明行）；另导出 `Config` 类型（= `PresetDefinition`） | `dsh-agent-preset/lib/index.js:29`；config-catalog `@deepseek-ai/dsh-agent-preset` 节 |
| `@deepseek-ai/dsh-agent-preset-registry` | `AgentPresetRegistry`（default，服务键 `agentPresets`）、`agentPresetProjectionDefinition`、`entryListProblem`、`auditRows`、`leakedServices` | `dsh-agent-preset-registry/lib/types/index.js:45-47,426-427`；子路径 `./types ./display ./typert ./remote`（package.json exports） |
| `@deepseek-ai/dsh-persona` | `Config`、`apply`、`inject`、`name`、`PERSONA_PREFIX_SECTION`、`PERSONA_SUFFIX_SECTION` | `dsh-persona/lib/index.js:50` |
| `@deepseek-ai/dsh-system-prompt` | `SystemPrompt`（default，服务键 `systemPrompt`）、`PERSONA_PREFIX_SECTION`、`PERSONA_SUFFIX_SECTION`、`TOOL_ORDER_REST`、`joinContextSections`、`renderContextSections`、`renderPrompt` | `dsh-system-prompt/lib/index.js` 尾导出 |
| `@deepseek-ai/cordis-plugin-loader` | `EntryGroup`（group 标记键）、`EntryTree`、`Group` | `dsh-agent-preset/lib/index.js:2`；`mount.js:3`；`cordis-plugin-loader/lib/index.js:48,103` |
| `@deepseek-ai/cordis-plugin-include` | `entryListSchema`（Loader 行列表 YAML schema，含 `!!js`） | `dsh-agent-preset-registry/lib/types/index.js:39`；`cordis-plugin-include/lib/index.js:393` |
| `@deepseek-ai/dsh-scope` | `scopeOf`、`createScope`、`scopeParentOf`、`bindScopeParent`、`scopeChainOf`、`ScopedLayers`、`NamedEntries`、`AnonymousEntries` | `mount.js:5`；registry index.js:38；`dsh-tools/lib/index.js:4` |
| `@deepseek-ai/dsh-typert-protocol` | `Remote`（装饰器）、`RemoteError`、`TypertRemoteService` | registry index.js:37 |
| `@deepseek-ai/dsh-app-boot` | `prepareProfileEntries` 等（宿主内部用；插件一般不 import） | `mount.js:4`；导出行 `dsh-app-boot/lib/index.js:5315` |
| `@deepseek-ai/dsh-config-editor` | `ConfigEditor`（default，服务键 `configEditor`） | `dsh-config-editor/lib/index.js:16-20` |
| `@deepseek-ai/dsh-settings` | Settings 服务（服务键 `settings`；`update(ns, patch, expectedRevision)` 等） | `dsh-settings/lib/index.js:470`；服务装载样例 README.zh.md:28-31 |
| `@deepseek-ai/dsh-llm` | `HarnessError`（工具错误基类来源） | `dsh-tools/lib/index.js:5` |

---

## 7. 附录：最小可用样例两份

### 7.1 新增一个自定义代理预设（自定义系统提示词 + 受限工具清单）——一条完整 preset 声明 yml

放在你的 bundle 包内（如 `preset/myagent.cordis.yml`），并把该路径加进 `package.json` 的
`"dsh": { "bundle": { "patch": ["./cordis.patch.yml", "./preset/myagent.cordis.yml"] } }`（宿主不 glob，必须逐文件列出，§0）。
基础组合已带 `@deepseek-ai/dsh-agent-preset-registry`（`config.default: standard`，`dsh-web-app/cordis.patch.yml:590-593`），无需重复挂；要把它设为默认，可在 profile patch 里覆盖注册表行的 `config.default`。

```yaml
# 一条自定义代理预设：自定义系统提示词 + 受限工具清单。
# 行结构同宿主自带 presets/standard.patch.yml:5-11。
- insert:
    - id: preset-myagent                 # Loader 行 id（编辑地址；勿与其它行重名）
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: myagent                      # preset 标识（会话按它选择；须唯一）
        name: My Agent                   # 花名册展示名（可选）
        description: 最小自定义编码代理   # 展示说明（可选）
        order: 30                        # 花名册排序（可选）
        plugins:
          # 系统提示词：complete: true = 整段替换默认提示词（只允许一个 complete 段）。
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: >-
                You are a coding agent powered by the {{model}} model.
                Keep answers short and cite file paths.
              complete: true             # 不要拼宿主各段时才设；省略则与宿主各段拼合
              includeRuntimeContext: true
          # 需要的其它模型可见行逐条列出——这就是工具白名单。
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              applyPatch: false          # 工具自身 config 也可裁剪子能力
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
          - id: tool-ask-user
            name: '@deepseek-ai/dsh-tool-ask-user'
          # 提供服务的行必须成组并裹 isolate（true = 本预设私有实例），
          # 否则泄漏审计整树回滚（agent-preset/invalid）。
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
```

写行纪律：**所有 `@scope/…` 包名必须带引号**（YAML 保留字符 `@`，§5.4-1）；每行须有非空 `name`；挂了不存在的包/子路径 → never started → 整预设回滚。改完重开宿主生效。

### 7.2 注册工具 + 读配置的最小宿主插件代码

（TypeScript；来源约定即官方教程 `develop/basic/tool.md:9-31` 与 cookbook `adding-a-tool.md:7-33`；`complete_task` 按 brief 要求命名。）

```ts
// src/index.ts —— 声明行：- id: complete-task-tool / name: '@me/my-plugin'（或 './src/index.ts'）
import Schema from '@deepseek-ai/schemastery'            // 配置 schema（§4.1）
import type { Context } from '@deepseek-ai/cordis'       // 仅类型
import { defineTool } from '@deepseek-ai/dsh-tools'      // 工具 DSL（§2.2）

export const name = 'complete-task-tool'
export const inject = ['tools']                          // 等工具注册表就绪

/** 插件配置：行上 config: { label } 传入；label 可被 Settings 编辑（volatile）。 */
export interface Config { label: string }
export const Config = Schema.object({
  label: Schema.string().default('task').volatile(),     // 只有 volatile 字段能在 Settings 改
})

export function apply(ctx: Context, config: Config) {
  // —— 读别的行的即时配置（0.2.x 没有 settings.get()；settings 命名空间 = 对方行 id）——
  // const editor = ctx.get('configEditor')
  // const row = editor?.entries().find((e) => e.options?.id === 'superpowers-delegation-settings')
  // const foreign = row === undefined ? undefined : unvolatile(row.fiber?.config)

  ctx.tools.register(defineTool({
    name: 'complete_task',
    description: 'Mark the current task complete with a one-line summary.',
    parameters: {                                        // 作者 DSL：编译成 JSON Schema 并自动校验模型参数
      summary:  { type: 'string', required: true, description: 'One line: what was accomplished.' },
      artifacts:{ type: 'array', items: { type: 'string' }, description: 'Deliverable file paths.' },
    },
    output: {
      schema: {                                          // 规范值 schema（ValueSchemaSpec）
        type: 'object', additionalProperties: false,
        properties: { accepted: { type: 'boolean', required: true } },
      },
      render: (_args, value) =>                          // 规范值 → 面向模型的内容块
        [{ type: 'text', text: value.accepted ? 'Task accepted.' : 'Task rejected.' }],
    },
    timeoutMs: 10_000,                                   // 可选；必须正有限数
    async execute(args, exec) {                          // args 已校验；exec.signal 必须遵守
      if (exec.signal.aborted) throw new Error('aborted')
      return { accepted: true }                          // 返回规范 JSON 值；抛异常 ⇒ isError
    },
  }))
}
```

挂载行样例：

```yaml
- insert:
    - id: complete-task-tool
      name: '@me/my-plugin'        # 裸包名或 './src/index.ts'；@ 开头必须加引号
      config:
        label: my-task             # 经 Config schema 校验后传入 apply
```

---

## 8. 查证中 NOT FOUND 及已排除的假设

1. **`preset/*.cordis.yml` 的宿主 glob 装载**：NOT FOUND。已搜 `dsh-app-boot/lib/index.js`、`dsh/lib/profile-boot-e2mS45fC.js`、`cordis-plugin-loader`、`dsh-plugin-manager` 全文，宿主只按 `dsh.bundle.patch` 的**显式文件列表**装载（§0）。
2. **`ctx.settings.get(...)`**：NOT FOUND（0.2.x 已无此 API）。已搜 `dsh-settings/lib/index.js`（无 get；只有 update/replace/mutate/write）与 superpowers 运行时读法（走 `configEditor.entries()`，§4.2）。
3. **宿主级「preset 工具白名单配置键」**：NOT FOUND——限制 = 组合级选择 + `tools.restrict()` + 工具自身 config（§1.5）；`ToolsService.Config` 只剩两个已废 `z.never()` 键（`dsh-tools/lib/index.js:406-409`）。
4. **preset 行内主会话模型/提供商键**：NOT FOUND——主模型来自会话 model selection；preset 只能经自带绑定插件发布模型或给子代理钉 `agentOptions`（§1.6）。
5. asar 内 `dsh-tools` 等包**未随 `.d.ts`**（exports 指到的 dts 文件在包内缺失，全树仅 16 个 d.ts）；类型以包内 JSDoc 源 `lib/types/*.js` 为准（§2.2）。
