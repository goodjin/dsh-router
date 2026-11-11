/**
 * 环境模块声明（types-only，tsc 输入不产物）：
 * `@deepseek-ai/dsh-compaction-basic` 只在宿主运行时安装，本仓 node_modules 没有，
 * tsc 静态解析不到。src/compaction.ts 的动态 import 依赖这里的 ambient 声明
 * 拿到最小结构面；真形状以宿主安装为准（结构对齐，见 tests/task-summary-engine.spec
 * 的信封断言与 docs/research/r2-sessions.md §7 的取证）。
 */

declare module '@deepseek-ai/dsh-compaction-basic' {
  /** 官方压缩引擎基类（具名导出与默认导出同值；运行时动态 import 取真类）。 */
  export const BasicCompactionEngine: unknown
  /** 官方行 config 的 zod schema（本仓不消费，仅保声明完整）。 */
  export const Config: unknown
  export {}
}
