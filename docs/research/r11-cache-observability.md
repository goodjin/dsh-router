# R11：DSH 前缀缓存命中可观测性 — 分叉 worker 首请求是否复用了来源会话的 KV 缓存

- 核对日期：2026-11-07
- 双版本：CLI 宿主 0.2.1-rc.2（直读 `~/.local/share/node-v24.18.1-darwin-arm64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`，下称 `CLI:`）、桌面版 asar 0.2.2-rc.1（只读提取到 `/tmp/dsh-asar-r11/dsh/node_modules/@deepseek-ai/`，下称 `ASAR:`）。
- 结论先行：**能观测，且有真实日志证据**。每次模型调用的 provider 回报 usage（含缓存命中数）以 `TokenUsage` 形态落进会话日志 `assistant/message` 事件的 `usage` 字段；分叉/子会话首请求的 `usage.cacheReadTokens > 0` 即是「复用了既有 KV 缓存前缀」的直接证据。本机两条真实首请求样本均 >0（见 §3）。

---

## 1. llm.stream 的 usage 载荷字段全集与流转链路（双版本）

### 1.1 字段全集：`TokenUsage`（dsh-llm 统一词汇表）

`CLI:dsh-llm/lib/types/types.d.ts:160-173`（`ASAR` 的同名声明嵌在 `ASAR:dsh-llm/lib/typert.host.js:632` 的 typert declaration 字符串里，字段一致）：

| 字段 | 含义（源码注释如实摘录） |
| --- | --- |
| `inputTokens: number` | **未命中缓存的输入**（disjoint，不含缓存部分） |
| `outputTokens: number` | 输出 |
| `totalTokens?: number` | 全调用总量（含聚合 prompt 与输出） |
| `cacheReadTokens?: number` | **缓存命中读**（前缀缓存 hit，即本题要测的量） |
| `cacheWriteTokens?: number` | **缓存写入**（cache creation，本次新写入缓存的输入） |
| `reasoningTokens?: number` | 推理 token |

关键注释（`CLI:dsh-llm/lib/types/types.d.ts:155-159`）：「Counts are DISJOINT: `inputTokens` is uncached input only; cached input is reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input = sum of the three). Adapters whose providers fold cache hits into a total prompt count (DeepSeek's `prompt_tokens`) subtract them out.」→ **计费口径的 prompt = inputTokens + cacheReadTokens + cacheWriteTokens**。

注意：字段名是 DSH 规范化的 **`cacheReadTokens`/`cacheWriteTokens`**，不是 `prompt_cache_hit_tokens`（DeepSeek 原名）也不是 `cache_read`（pi-ai 内部名）——那些只在适配器边界出现（见 1.3）。

### 1.2 流转链路：provider → StreamChunk → 会话日志

1. **流内载荷**：`StreamChunk` 的 usage 变体 `{ type: 'usage'; usage: TokenUsage }`（`CLI:dsh-llm/lib/types/types.d.ts:456-458`）。
2. **事件入口**：`llm/stream` 是 LlmRuntime 上的 waterfall（`CLI:dsh-llm/lib/types/index.d.ts:29-45`），插件可在瀑布里 `for await` 消费 chunk。
3. **agent-loop 捕获**：循环把 chunk 推进 assembler，`get usage()` 取「Latest adapter-reported usage in the stream」（`CLI:dsh-agent-loop/lib/types/assistant-stream.d.ts:46-47`）。
4. **落日志**：请求结算时 `session.append("assistant/message", { turn, step, message, ...{ usage: live.usage }, stream: live.stream })`（`CLI:dsh-agent-loop/lib/index.js:1160`；中断分支同样带 usage 在 `:1110`。桌面版 `ASAR:dsh-agent-loop/lib/index.js:953` 与 `:903`）。**没有单独的 usage 记录，用量与消息同行**（`CLI:dsh-session/lib/types/types.d.ts:323-325` 注释）。
5. **折叠投影**：token-meter 的 `tokenUsage` 投影「Each v2 Assistant settlement contributes the last usage sample embedded in its stream」累计为 totals + last（`CLI:dsh-token-meter/lib/types/usage-projection.d.ts:34-40` 及 schema）。

### 1.3 哪些适配器填缓存字段（如实字段名）

| 适配器 | wire 原始字段 | 映射 | 证据 |
| --- | --- | --- | --- |
| `dsh-llm-deepseek`（DeepSeek Messages，Anthropic 风格 SSE） | `cache_read_input_tokens` / `cache_creation_input_tokens` | → `cacheReadTokens` / `cacheWriteTokens`；`totalTokens` 由四项相加派生 | `CLI:dsh-llm-deepseek/lib/index.js:1826-1827`（updateUsage 表），`:2006`（total 派生）；桌面版 `:1839`、`:2019` |
| `dsh-llm-pi-ai`（`@earendil-works/pi-ai`，openai-completions / anthropic-messages 等多协议） | pi-ai 内部 `usage.cacheRead` / `usage.cacheWrite` | → `cacheReadTokens` / `cacheWriteTokens`，**为 0 时省略字段**（"pi-ai reports zeros, not absence"） | `CLI:dsh-llm-pi-ai/lib/index.js:1438-1446`（mapUsage），桌面版 `:1461` |
| ↳ pi-ai 的 openai-completions 解析 | `prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens ?? cached_tokens`（OpenAI / **DeepSeek** / Kimi 三种摆位都认）；写缓存认 `prompt_tokens_details.cache_write_tokens` | 注释明确「DeepSeek uses prompt_cache_hit_tokens」 | `CLI:` 下 `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:1166-1190` |
| ↳ pi-ai 的 anthropic-messages 解析 | `cache_read_input_tokens` / `cache_creation_input_tokens` | → `cacheRead` / `cacheWrite` | 同库 `dist/api/anthropic-messages.js:499-500, 665-668` |

即：**DeepSeek 官方路由无论走 `dsh-llm-deepseek`（Messages 协议）还是走 pi-ai 的 OpenAI 兼容协议（`prompt_cache_hit_tokens`），缓存命中都能进 `cacheReadTokens`**；本机实测两路都出数（§3）。

## 2. 插件能否观察**其他会话**的逐请求 usage

结论：**能，三条路，均有宿主级入口；没有名为 `llm/usage` 或 `agent/request-*` 且带 usage 的全局事件**（全量 grep 无此事件名）。

1. **被动全局流（推荐，最低成本）**：`session/event` 是 scope 过滤事件 `'session/event'(this: Scoped<Session>, session, event)`（`CLI:dsh-session/lib/types/index.d.ts:61`），但 dsh-scope 的装配规则是「event admission extends UP it (a listener tagged with an ancestor receives events dispatched to a descendant key)」（`CLI:dsh-scope/lib/index.js:234-237`，桌面版 `ASAR:dsh-scope/lib/index.js:236`）→ **挂在根作用域的插件一个监听器收到所有会话的每条落账事件**，`event.data.usage`（assistant/message）逐请求可见，含分叉 worker 会话。种子事件不发布（`CLI:dsh-session/lib/index.js:1349`）。
2. **主动读任意会话日志**：`ctx.sessionQuery`（SessionQueryEngine）：`observeSession(sessionId)` 返回含 `events: readonly SessionEvent[]` 的不可变切面（`CLI:dsh-session-query/lib/types/index.d.ts:43-49`、`observation.d.ts:15-30`）；`readSession()` 一次读整段日志（同文件 `:83-88`）。live 与已持久化会话都可用。另有现成工具包 `dsh-tool-session-query` 把它暴露成 agent 工具。宿主的 api-session-controller 自己就是这么读别的会话的（`CLI:dsh-api-session-controller/lib/types/history.js:273`）。
3. **远程 API（跨进程/客户端同构）**：`session/page`（回翻日志，`SessionHistoryRecord = SessionEventEntry`，`data: JsonValue` 原样带 usage，`CLI:dsh-api-session-controller/lib/types/types.d.ts:425-449`）、`session/follow`（快照+增量+可选 assistant-stream 帧，`:508-548`）、`session/control`（**宿主级**流：baseline + 每会话每投影键的 `SessionProjectionUpdate`，`:561-570`；其中 `tokenUsage` 投影视图 = `{uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}` 全程累计，`contextPressure.pressureTokens` = 最近一次请求的 prompt 侧总量）。
4. 不满足的路径：`agent/assistant-stream` / `agent/request-error` 等 agent 事件是 agent 作用域过滤（`CLI:dsh-agent/lib/types/runtime-types.d.ts:340-368`），跨会话收不到别的 agent 的；但它们帧内 `chunk: StreamChunk` 含 usage chunk，对本会话内的 live 观测可用。

## 3. 会话日志里 usage 落在哪个事件字段（真实样本）

位置：`assistant/message` 事件的 **`data.usage`**（与 `turn/step/message/stream` 同级）；事件信封为 `{type, seq, time, data}`（`CLI:dsh-session/lib/types/types.d.ts:490-504`；usage 字段声明 `:337`）。stream 数组里同时保留一条 `{type:'usage'}` chunk 记录（`CLI:dsh-session/lib/types/types.d.ts:456-458` 的 StreamChunk）。

真实样本（本机日志，`~/.dsh/sessions/--Users-good-qg-glasses-wigain-system--/session-6af6c05d-d77b-45c9-b44b-4824bbb89d8a/session.v4.jsonl.zstd`，zstd 解压后 seq 522）：

```json
{"type":"assistant/message","seq":522,"time":1793960511364,
 "data":{"turn":7,"step":20,
  "message":{"role":"assistant","content":[…],"source":{"kind":"model","provider":"iquest","model":"iquest-q1","replayState":{"response":{"kind":"pi-ai","api":"openai-completions",…}}},"id":"…"},
  "usage":{"inputTokens":977,"outputTokens":717,"totalTokens":104478,"cacheReadTokens":102784},
  "stream":[{"type":"chunk",…},{"type":"usage",…},{"type":"finish",…}]}}
```

口径自检：977(未命中输入) + 102784(命中) ≈ 103761 ≈ prompt 侧；totalTokens=104478 = 103761 + 717(输出)。disjoint 口径成立。

**分叉/子会话首请求直接证据**（本机两个 worker 会话的首条 `assistant/message`）：

| 会话（`~/.dsh/sessions/…` 下） | 路由 | 首请求 usage（seq） |
| --- | --- | --- |
| `--Users-good-local-ai-eval-workspaces-dsh_813a3e2e…--/session-7b326caa…`（turn1/step1, seq 16） | deepseek-official / deepseek-v4-pro（deepseek-messages） | `{"inputTokens":8272,"outputTokens":5127,"cacheReadTokens":5632,"cacheWriteTokens":0,"totalTokens":19031}` |
| 同目录 `session-6340013b…`（turn1/step1, seq 15） | zai-coding-cn / GLM-5.3（pi-ai openai-completions） | `{"inputTokens":7996,"outputTokens":10534,"totalTokens":23842,"cacheReadTokens":5312}` |

两条首请求 `cacheReadTokens` 都显著 >0：新会话第一发就能命中数千 token 的缓存，说明 provider 侧复用了既有前缀（fork 种子/同路由近邻会话已把该前缀写热）。**注意这是必要非充分证据**：命中数证明前缀在缓存里，不能单凭它区分「来源会话写热的」还是「同模型路由其他会话/更早请求写热的」；要归因到来源会话，需配合对比种子前缀长度与命中量、以及时间邻接（同路由短时间内首请求高命中）。

## 4. token-meter 的估算与真实 usage 的关系（cached 是否计价/可见）

- **meter 是纯 token 计数，无货币概念**。启发式定价是固定密度算法（`CLI:dsh-token-meter/lib/types/estimate.d.ts:1-58`，角色开销 4 token 等）；`measure()` 优先复用 provider 真实 usage 作为基线，条件是「latest successful call's canonical request envelope matches `requestHeader` and its total is no lower than that call's full route-priced anchor」，否则整面重估（`CLI:dsh-token-meter/lib/types/index.d.ts:26-45`）。基线形态 `TokenMeasurementBaseline` 的 `kind:'usage'` 携带完整 `TokenUsage`（`CLI:dsh-token-meter/lib/types/types.d.ts:20-32`）。
- **cached 部分可见**：`cacheReadTokens` 原样进投影 totals/last（`CLI:dsh-token-meter/lib/types/usage-projection.d.ts:20-45`）与会话列表投影视图；UI 也直接求和使用它（`CLI:dsh-client-ui-subagent/lib/client.js:66`：`uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`）。
- **cached 部分在 DSH 内不计价**：`TokenUsage` 无 cost 字段；pi-ai 内部 `calculateCost`（含 cacheRead 单价）在适配器 `mapUsage` 边界被丢弃（`CLI:dsh-llm-pi-ai/lib/index.js:1438-1446` 只取 token 四项 + total）。即 DSH 任何日志/投影/事件里都**没有**金额，只有 token 数；「命中更便宜」这一层要插件自己按供应商价目折算。
- `contextPressure.pressureTokens` 说明（typert 投影 schema）：「Provider-reported prompt size of the most recent request: uncached input plus cache reads and writes」——它把命中数**计入**压力总量，不区分命中与否；`projectedTokens` 才是下一发预估。

## 5. 结论：给插件的最小可行观测面 + 降级观测

**最小可行观测面（推荐）**：插件挂根作用域监听 `session/event`，只过滤 `type === 'assistant/message'`，取 `event.data.usage`：

- 判定「分叉 worker 首请求复用了来源会话 KV 缓存」：worker 会话（`origin: 'subagent'` / fork 派生）的**第一条** `assistant/message` 的 `usage.cacheReadTokens > 0`（且量级与种子前缀长度可比）。跨进程等价物：对该 worker 会话 `session/follow` 读 snapshot+首事件，或事后 `ctx.sessionQuery.readSession()` 扫首条 assistant/message。
- 附带口径：`inputTokens` 是未命中部分，勿把它当总 prompt；总 prompt = inputTokens + cacheReadTokens + cacheWriteTokens。

**降级观测（供应商/适配器不回缓存字段时，如实说）**：

- 字段是可选的：`cacheReadTokens?` 本就允许缺席；pi-ai 路径在值为 0 时**省略字段**（`CLI:dsh-llm-pi-ai/lib/index.js:1444`）。拿不到 `cacheReadTokens` ≠ 没有命中，只是该路由未回报。此时只有两条间接信号：
  1. `totalTokens`（若适配器派生了它）与启发式估算（`tokenMeter.measure()` 的 heuristic 基线）的差值——差值显著偏小只能提示「prompt 被折叠/命中」，**无法定量化命中**（无直接证据，勿当结论用）；
  2. 供应商控制台/账单侧的缓存计费数据（DSH 内无任何金额面，见 §4）。
- `dsh-llm-deepseek`（Messages 协议）与 pi-ai（OpenAI 兼容 + Anthropic 协议）这两条本机在用路线都实测回数（§3 样本），降级情形主要出现在自定义 OpenAI 兼容网关不回 `prompt_tokens_details.cached_tokens`/`prompt_cache_hit_tokens` 时——pi-ai 会静默取 0 并省略字段。
- 另一现成旁证面：`compaction/summary` 事件也带 `usage?: TokenUsage` 且带 `llmStreamCall: true` 标记（`CLI:dsh-compaction/lib/types/types.d.ts:35-67`，`usage` 在 `:57`；compaction-basic 摘要调用显式「重放会话前缀以复用 provider 前缀缓存」，见 r2-sessions.md §7.3/259 行）——它证明「同一会话内前缀复用」在 DSH 自身机制里是被有意利用并被记录的，读法与 assistant/message 相同。

### 证据文件清单

| 版本 | 文件：行 | 内容 |
| --- | --- | --- |
| CLI 0.2.1-rc.2 | `dsh-llm/lib/types/types.d.ts:160-173, 456-458` | TokenUsage 字段全集；usage chunk |
| CLI | `dsh-llm/lib/types/index.d.ts:29-45` | `llm/stream` waterfall |
| CLI | `dsh-llm-deepseek/lib/index.js:1826-1827, 2006` | cache_read/write_input_tokens 映射与 total 派生 |
| CLI | `dsh-llm-pi-ai/lib/index.js:1438-1446` | mapUsage（0 值省略） |
| CLI | `…/@earendil-works/pi-ai/dist/api/openai-completions.js:1166-1190`；`anthropic-messages.js:499-500, 665-668` | wire 字段三种摆位 |
| CLI | `dsh-agent-loop/lib/index.js:1110, 1160`；`types/assistant-stream.d.ts:46-47` | usage 进 assistant/message |
| CLI | `dsh-session/lib/types/types.d.ts:317-338, 456-458, 490-504` | 事件 schema 与 usage 字段 |
| CLI | `dsh-session/lib/types/index.d.ts:61`；`dsh-scope/lib/index.js:234-237` | session/event 作用域向上放行 |
| CLI | `dsh-session-query/lib/types/index.d.ts:43-49, 83-88`；`observation.d.ts:15-30` | observeSession/readSession |
| CLI | `dsh-api-session-controller/lib/types/types.d.ts:425-449, 508-570` | page/follow/control + 投影视图 |
| CLI | `dsh-token-meter/lib/types/{index,types,estimate,usage-projection}.d.ts` | 估算与真实 usage 的锚定关系 |
| CLI | `dsh-compaction/lib/types/types.d.ts:35-67` | compaction/summary usage + llmStreamCall |
| CLI | `dsh-client-ui-subagent/lib/client.js:66` | UI 求和含 cacheRead |
| ASAR 0.2.2-rc.1 | `dsh-llm/lib/typert.host.js:632`；`dsh-llm-deepseek/lib/index.js:1839, 2019`；`dsh-llm-pi-ai/lib/index.js:1461`；`dsh-agent-loop/lib/index.js:903, 953`；`dsh-scope/lib/index.js:236` | 同上字段与行为，双版本一致 |
| 本机日志 | `~/.dsh/sessions/--Users-good-qg-glasses-wigain-system--/session-6af6c05d…/session.v4.jsonl.zstd`（seq 522）；`…dsh_813a3e2e…/session-7b326caa…`（seq 16）；`…/session-6340013b…`（seq 15） | 真实 usage 样本与两条分叉首请求命中证据 |
