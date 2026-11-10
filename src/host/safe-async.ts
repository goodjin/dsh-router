/**
 * 「发射后不管」的异步调用的统一出口。
 *
 * 宿主（dsh-app-boot 的 installFailLoud）把任何**未捕获的 promise rejection**
 * 当成致命错误：打印 `fatal load failure` 后 `exit(1)`，桌面版随即把它记成
 * 「应用崩溃」并弹出重装提示——其实什么都没坏。
 *
 * 插件里最容易踩的就是「定时器/事件回调里发起异步、结果没人接」：一旦回调
 * 打到已失效的宿主上下文（插件被卸载/重载的竞态窗口），cordis 会抛
 * `cannot get required service "…" in inactive context`，异常一路逃到进程级，
 * 整个桌面版被带走。
 *
 * 2026-11-10 现场：Router 的 60 秒「快照项目列表补刷」定时器正好撞上插件
 * 被卸载的窗口，读已失效的 workspaceRegistry，宿主 exit(1)（同类的坑在
 * 2026-11-09 已出过一次，当时只修了判定器那条路径）。
 *
 * 纪律：插件内凡是「发射后不管」的异步调用一律走这里——就地吞掉异常、记一
 * 行日志，不让它逃到进程级。
 */

/** 日志口（只要 warn 就够）。 */
export interface AsyncGuardLogger {
  warn(message: string): void
}

/** 发射后不管的调用签名。 */
export type FireAndForget = (label: string, work: () => Promise<unknown>) => void

/** 把任意抛出物压成一行可读文本。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 造一个安全的「发射后不管」调用器。
 *
 * - work 返回的 promise 被拒绝 → 记一行 warn，不产生未捕获 rejection；
 * - work 同步抛出 → 同样记一行 warn，不打断调用方。
 */
export function createFireAndForget(logger: AsyncGuardLogger): FireAndForget {
  return (label, work) => {
    let promise: Promise<unknown>
    try {
      promise = Promise.resolve(work())
    } catch (error) {
      logger.warn(`${label}失败: ${describeError(error)}`)
      return
    }
    void promise.catch((error) => {
      logger.warn(`${label}失败: ${describeError(error)}`)
    })
  }
}
