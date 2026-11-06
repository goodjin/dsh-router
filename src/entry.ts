/**
 * 宿主侧的挂载行：什么都不做。
 *
 * DSH 找浏览器半边的方式不是读 package.json 的 dsh.client，而是扫 Loader 的行：
 * 只有某一行的 name 恰好等于包名（裸包名）时，那个包才会进 window.__DSH_BOOT__
 * （`ClientModuleRegistry.resolveMeta` 经 `locatePkgJson` 解析；带子路径的名字
 * 不算客户端行）。本包 cordis.patch.yml 里 `dsh-router-client` 那一行挂的就是
 * 这里的 name，导入的也就是这个文件。
 *
 * 它必须能在 node 里安全 import：浏览器代码（React、DOM）只住在 src/client/，
 * 经 tsdown 打成 lib/client.js、由 exports["./client"] 下发给页面，绝不混进
 * 宿主进程。这与 DSH 自己那些 `dsh.client` 包、以及 dsh-chat-power 的空入口一致。
 *
 * 与 chat-power 的一处差别：本仓 "." 入口指向 tsc 编译产物 dist/entry.js
 * （package.json 的 main / exports["."]），不再直出 src——所以改了这个文件
 * 必须重建（npm run build），宿主加载的才是新代码。
 */

/** Loader 行与诊断里看到的插件名（裸包名，与 cordis.patch.yml 的行一致）。 */
export const name = '@goodjin2/dsh-router'

/** 宿主侧没有行为：任务编排的宿主半边（路由 / 工具 / 预设行）待契约研究返回后再接。 */
export function apply(): void {}
