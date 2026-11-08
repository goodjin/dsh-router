# Router 收编：读取成本、诊断与运行边界（v1.4）

核对日期：2026-11-08。宿主格式依据本机 DSH 0.2.2-rc.1（会话日志 v4）。本说明
描述 v1.4 语义下的实现：Router 会话全部独立（不去重、不归档、不跳转、不复用），
收编扫描只负责把 picker 自建的 Router 预设会话登记进 `ui.routerSessions` 并幂等
补发身份卡；判定源是已评审的受限读取器 + 持久化增量索引（router-header-index
迁移），不再走宿主 `readSession()` 整日志重放。

## 行为与成本（2026-11-07 OOM 现场之后的设计）

- 收编判定不调用宿主 `readSession()`，也不做整语料 `stat/list/open` 兜底。冷盘
  小日志只按有界 stable-EOF 扫描取「最终预设组合」；live 会话经宿主
  `sessionProjections` 的 `agentPreset` 投影与 `agent-preset/selected` 事件直达
  判定（零盘读）。
- `/router/state` 每 2.5 秒轮询一次：收编每轮只消费索引的**增量候选**
  （`changedRouterCandidates`：状态 revision 未前进 → 空清单）与**定点**磁盘
  事实核验（`verifyDiskFacts`：一次只点一个候选名）。稳态轮次零副作用——
  不再出现旧现场「每轮全量重扫 = 200%+ CPU、几十分钟堆满 4 GB JS 堆」。
- 索引自带护栏（沿用已评审机制）：首次 bootstrap 有界分批（全局每批最多 10
  次尝试，失败也占预算）、瞬态失败冷却 10 分钟、后台推进约每 250ms 一批、
  低频目录对账默认 60 秒、判定按 root+preset+版本持久化（指纹未变直接复用）、
  单飞 + 安全 dispose（在途读取收尾、状态冲刷完成后才真正消停）。
- 收编侧护栏：每轮预算（默认 10 次异步副作用）、单飞、失败候选进重试队列
  （连续失败达上限默认 5 次后出队，等索引重新发放）、身份卡投递幂等（进程内
  delivered 集合 + 桥侧已发标记 + requestId 去重）。
- 异步安全：每个候选在定点核验之后、登记等待之后都重新核对「当前仍是 router
  判定 + 仍在工作区成员里」；等待期间翻面/离开的候选只跳自身，不按 stale 计划
  登记或投递。单个候选失败（IO 超时/拒绝/异常）不阻断同工作区邻居。

### 默认扫描上限（冷日志 stable-EOF）

| 项目 | 上限 |
| --- | --- |
| 文件输入（压缩侧或明文） | 256 KiB，允许最多 1 字节探测是否超限 |
| 总解压输出 | 1 MiB |
| 事件行数 | 4096 |
| 单行 | 64 KiB |
| 单次读取生命周期 | 2 秒 |

超时让调用方及时返回；无法立即取消的底层 IO 仍占有限额度，直到真实完成及清理
后才归还。种子（seeded/fork）会话沿用排除规则（nonrouter）。

## 明确的功能限制

旧格式（v3-）、未来格式、超限、损坏、截断、存在歧义或读期间变化的日志保持
`unknown`——**只跳过该候选自身**，不阻断同工作区其他已确认 Router 的登记与
投递（v1.4 语义：unknown 不再有「挡住整个工作区」的效力）。表头不是最终预设
的可靠证明；首次 turn 也不是安全停止边界；本实现不使用这两类快捷判据。

冷文件变化有默认 60 秒发现延迟（低频对账）；跨进程文件写入与 registry 动作
没有事务级原子性保证。live 会话读不到权威投影值时保守判 `unknown`，等
`agent-preset/selected` 事件到达再前进。

## 自报状态（GET /router/health）

使用现有宿主准入方式访问（需插件已启用）。接口不触发任何盘 IO，返回索引计数
与 `adoption` 段：

| 字段 | 含义 |
| --- | --- |
| `bootstrap.initialDone` / `lastReconcileAt` / `lastReconcileError` | 目录发现是否已跑、最近对账及错误 |
| `queueLength` / `failures` | 索引待处理与失败冷却计数 |
| `entries.router` / `nonrouter` / `unknown` / `byEvidence` | 当前判定分布与证据来源（stable-eof / 种子表头 / live） |
| `header.attempts` / `cacheReused` / 字节计数 | 实际头读取与复用成本（含失败消耗） |
| `scan.attempts` / `finals` / `caps` / `unstable` | 小日志扫描结果 |
| `adoption.rounds` / `registered` / `delivered` | 收编轮次与成功登记/投递计数 |
| `adoption.retryQueue` / `verifyRejected` / `staleSkipped` / `retriesDropped` / `errors` | 重试队列长度与各类跳过/失败计数 |
| `adoption.inflight` | 是否有进行中的收编轮（单飞可见） |

诊断不返回会话正文、标题或路径。`entries.unknown` 不为零不是故障；把
`initialDone` 当作全历史覆盖同样不成立。

## 状态与部署纪律

判定索引保存在插件 dataDir 下 `session-index.json`（新文件名，不复用旧去重器
的 `dedup-index.json` 语义；旧文件不迁移也不自动删除），按 schema、会话根和
preset 隔离，载入缓存未经指纹核对前不授权任何副作用。

源码与四个宿主自包含入口产物（`dist/entry.js` 等）+ 浏览器产物（`lib/client.js`）
必须一起提交；部署前跑 typecheck、全套测试、build、二次构建字节比对，以及仅
跟踪文件的干净安装加载测试（`tests/tracked-install.spec.ts`）。离线门禁不能替代
真实桌面验证。

本任务不自动改 profile 的 disabled 覆盖、不合并主干、不推送、不重启桌面；启用
与重启由用户决定。首次启用后观察上述诊断、CPU/内存趋势与真实收编行为；异常时
保留禁用配置定位，不以反复重启代替排查。
