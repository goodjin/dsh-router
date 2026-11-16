/**
 * Native two-level collaboration flow (计划 Task 4 Phase B；最高风险；实测后 SKIPPED)。
 *
 * 目标场景（brief Phase B）：
 *  - native_hierarchy_and_reports：Router 真实创建主管、主管真实创建成员；断言两层深度、
 *    初始角色说明/rootSessionId、成员报告及父级通知、模板文本传递、成员结束不改记录标签。
 *  - partial_actions_are_visible：报告保存后消息调用失败 → 报告仍可读且失败返回模型；
 *    创建成功但记录写失败仍保留 childId，不启动第二个 child。
 *
 * 为什么 SKIPPED（不是 fake PASS）：需要一个公开的、无付费模型的「脚本化 LLM 注入点」来驱动
 * 真实 DSH Agent（Router→主管→成员两级）。调查结果（2026-11-16，官方文档 + 已装 CLI 源码）：
 *  1. 官方设计里确有可 cordis 加载的脚本化 LLM seam `@deepseek-ai/dsh-llm-replay`
 *     （config-catalog §llm-replay，inject:['llm']），但它从**录制的 v4 会话日志**回放每次模型调用；
 *     子会话（主管/成员）脚本只能来自真实录制的 child 日志（loadSessionScripts 里 childFiles
 *     走 deriveReplayScript(fixture.events)），只有主会话能用 bare ReplayEntry[] sidecar 替换。
 *     没有公开 API 能在无先验录制的情况下合法构造一套 v4 多会话 fixture。
 *  2. `dsh-llm-replay` **不在任何可达宿主里**：已装 CLI（@deepseek-ai/dsh 0.2.1-rc.2 全局）
 *     与桌面 app.asar（0.2.2-rc.1）都没有该包；作者工具（dsh-session-snapshot /
 *     dsh-agent-loop-testkit / dsh-llm-mock-server）都是「库包（无插件入口）」且未安装。
 *  3. 官方 providers 文档显示每条模型路由都要真实凭据（DeepSeek 账号 / 第三方网关 / 自定义
 *     OpenAI 兼容端点 + API key）；CLI `dsh headless` 因此必须走付费/网关模型，brief 禁止。
 *
 * 故公开 test-model 注入点在可达宿主上不存在 → 按 brief「记录精确缺口、native-flow 标 SKIPPED
 * 附原因、不 fake PASS、不改宿主、不造通信层」。下列断言描述的是**一旦有可驱动的脚本化 LLM
 * seam + fixture 构造能力**就要成立的真实机制契约；当前用 it.skip 登记，不计入 PASS。
 * check-collaboration-host.mjs 另行证明候选声明解析 + 单预设组合继承（不 claim live flow）。
 */

import { describe, expect, it } from 'vitest'

const NATIVE_FLOW_SKIP_REASON =
  'no public no-paid test-model injection point in any reachable host: ' +
  '@deepseek-ai/dsh-llm-replay (the only cordis-loadable scripted-LLM seam) is absent from the ' +
  'installed CLI 0.2.1-rc.2 and desktop app.asar 0.2.2-rc.1; it replays from RECORDED v4 ' +
  'session-log fixtures and nested (child) sessions require real recorded logs, with no public ' +
  'fixture-authoring API; every documented model route needs real credentials. ' +
  'See .superpowers/sdd/2026-11-16-router-lightweight-implementation/task-4-report.md Phase B.'

describe('native two-level collaboration flow (Task 4 Phase B) — SKIPPED, not counted as PASS', () => {
  it.skip('native_hierarchy_and_reports — Router spawns supervisor, supervisor spawns worker; two-level depth, initial role message carries rootSessionId/parent/report path, template text passed, member end does not change workLabel', () => {
    // 登记为 skip：不执行、不计 PASS。缺口原因见 NATIVE_FLOW_SKIP_REASON 与 report Phase B。
    // 当可驱动时的断言（占位，不执行）：
    //  - 两层：Router 会话深度 0，主管子会话深度 1，成员子会话深度 2（宿主 maxDepth=2 未超）。
    //  - 主管/成员初始任务消息自足：含当前角色、上级 sessionId、rootSessionId（资料根目录）、
    //    记录目录、报告位置、专业职责（模板文本逐字传入）。
    //  - 成员报告写入独立 report 记录，主管可读；主管向 Router 汇总。
    //  - 成员会话正常结束（宿主本轮结束）不改变其报告的 workLabel（不从会话结束推断业务完成）。
  })
  it.skip('partial_actions_are_visible — report saved then message fails → report still readable + error returned to model; child created then record write fails → childId retained, no second spawn', () => {
    // 登记为 skip：不执行、不计 PASS。
    // 当可驱动时的断言（占位，不执行）：
    //  - 报告保存成功后 send_message/notify 失败：报告文件仍可读，失败作为 tool error 返回模型，
    //    不自动重派、不删除报告。
    //  - 子会话创建成功但关联记录写失败：保留宿主返回的 childId，由模型补记，不另起第二个 child。
    //  - 只验证机制；测试驱动不自动判定业务完成。
  })
})
