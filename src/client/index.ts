/**
 * DSH Router — 浏览器半边（最小占位）。
 *
 * Router 的定位：主管 / 工作型 worker 的会话任务编排（任务的拆分、派发、
 * 追踪、汇总）。界面接线还没开始：本文件现在只提供一个 root 级别可运行的
 * 空 apply——不注册、不注入任何 slot——保证 ModuleLoader 工厂可被页面加载、
 * 装载接线测试可跑。等契约研究返回后，真正的表面（任务面板、worker 状态区、
 * 派发进度等）参照 dsh-chat-power 的 src/index.ts 写法挂进宿主的 slots。
 */

/** Loader 行与诊断里看到的插件名；与 cordis.patch.yml 的裸包名行一致。 */
export const name = '@goodjin2/dsh-router'

/**
 * 依赖：占位阶段不请求任何页面模块。
 *
 * 接线后按 chat-power 的方式声明（`'slots'` 等）。这里宁可先空着：
 * 多要的依赖会在注册表缺它时让整条 entry 启动失败（启动审计判 failed，
 * 整页打不开）；空数组没有任何这类风险，等真正用到再加。
 */
export const inject = [] as const

export interface PluginContext {
  logger(name: string): { info(message: string): void; warn(message: string): void }
  effect(callback: () => unknown, name?: string): unknown
  get(name: string): unknown
}

/**
 * 空 apply：不挂任何 slot。只留一行自报状态——按仓库纪律，会静默失败的
 * 程序动手时就要留一个能自报状态的入口；装没装上，浏览器控制台一眼可见。
 * 日志走插件的 logger，取不到时退回 console，绝不因为日志把整条 entry 弄挂。
 */
export function apply(ctx?: Partial<PluginContext>): void {
  const message = 'client placeholder loaded — no surfaces registered yet (router scaffolding)'
  try {
    const log = ctx?.logger?.(name)
    if (typeof log?.info === 'function') {
      log.info(message)
      return
    }
  } catch {
    // 落下去，用 console
  }
  console.info(`[${name}] ${message}`)
}
