/**
 * 浏览器半边的打包配置。
 *
 * DSH 只下发 `exports["./client"]` 指向的那一个文件，并原样塞进页面的模块表；
 * 它必须是「单文件 CJS 工厂」，外面套一层 `window.__ModuleLoader__.load(...)`，
 * factory 收到的 `require` 负责把 react 这类外置模块从页面的模块表里取出来。
 * 这与 DSH 自带客户端插件、以及 @goodjin2/dsh-chat-power / @goodjin2/dsh-acp-agent
 * 的产物同款。
 *
 * 输入是 tsc 的中间产物（本仓 tsconfig.json 不写 rootDir、include 只有 src，
 * tsc 自动取公共目录 src/，所以 src/entry.ts 平铺成 dist/entry.js、
 * src/client/index.ts 成 dist/client/index.js）。rolldown 不会替我们把源码里
 * `.ts` 后缀的相对引用改写到编译产物，所以从 tsc 中间层打包。
 *
 * 构建要可复现：产物入库（lib/client.js），同一份源码必须得到同一份字节。
 * 本仓骨架没有 .module.css；等接入需要 CSS 的表面时，把 chat-power 的
 * lightningcss「运行时注入 <style> + 类名映射」插件搬回来（lightningcss 已在
 * devDependencies），并保留它「按基名算哈希、exports 按键排序」的两条可复现纪律。
 */

import { isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const id = '@goodjin2/dsh-router'
const root = fileURLToPath(new URL('.', import.meta.url))
// 页面模块表里已有的东西不打包（打进产物会出现第二份 React 实例）。
// 与 package.json 的 dsh.client.external 保持同一份清单；占位阶段 factory
// 实际一个都不 require，留着是为了后续接线时不改清单就安全。
const externals = new Set([
  '@deepseek-ai/dsh-client-ui-sidebar-files',
  '@deepseek-ai/dsh-client-ui-sidebar-browser',
  '@deepseek-ai/dsh-client-ui-sidebar-terminal',
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
  'react-dom',
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
])

export default defineConfig({
  entry: { client: `${root}dist/client/index.js` },
  outDir: `${root}lib`,
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  minify: true,
  clean: false,
  external: [...externals],
  noExternal: (specifier: string) => !externals.has(specifier),
  outputOptions: {
    inlineDynamicImports: true,
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    sourcemapPathTransform: (source: string) => isAbsolute(source) ? relative(root, source).replaceAll('\\', '/') : source,
  },
})
