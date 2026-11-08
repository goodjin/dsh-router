/**
 * 打包配置（浏览器产物 + 宿主入口自包含 bundle）。
 *
 * 浏览器半边（lib/client.js）：DSH 只下发 `exports["./client"]` 指向的那一个
 * 文件，并原样塞进页面的模块表；它必须是「单文件 CJS 工厂」，外面套一层
 * `window.__ModuleLoader__.load(...)`，factory 收到的 `require` 负责把 react
 * 这类外置模块从页面的模块表里取出来。输入是 tsc 的中间产物（本仓
 * tsconfig.json 不写 rootDir、include 只有 src，tsc 自动取公共目录 src/，
 * 所以 src/entry.ts 平铺成 dist/entry.js、src/client/index.ts 成
 * dist/client/index.js）。
 *
 * 宿主半边（dist/entry.js 等 four entries，fix round 1 I9）：tsc 平铺产物带
 * `./host/...` 相对导入，而 dist/host、dist/shared 都不入库——GitHub 安装只有
 * 跟踪文件，加载直接失败。改为从 TS 源直接把四个宿主入口各打成**自包含
 * bundle**（相对闭包全部内联；node:* 与 @deepseek-ai/* 保持外置，由宿主进程
 * 提供）。同源码同字节的可复现纪律不变（固定 banner/footer、确定序）。
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

/** 宿主入口（package.json exports 的四个宿主子路径）。 */
const hostEntries = {
  entry: 'src/entry.ts',
  tools: 'src/tools.ts',
  context: 'src/context.ts',
  'prompt-section': 'src/prompt-section.ts',
} as const

const clientConfig = defineConfig({
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

/** 每个宿主入口一份配置（单 entry 才能确保 inlineDynamicImports 语义干净）。 */
const hostConfigs = Object.entries(hostEntries).map(([name, input]) =>
  defineConfig({
    entry: { [name]: `${root}${input}` },
    outDir: `${root}dist`,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    dts: false,
    sourcemap: true,
    minify: false,
    clean: false,
    // node 内建与宿主侧 @deepseek-ai/* 由宿主进程提供，保持外置。
    external: [/^node:/, /^@deepseek-ai\//],
    outputOptions: {
      // 源码里的相对动态导入（adjudicator 的 memory/adapter 等）全部内联：
      // 不产 chunk 文件——chunk 名带哈希既不可复现也不入库，破坏自包含。
      inlineDynamicImports: true,
      entryFileNames: '[name].js',
      sourcemapPathTransform: (source: string) => (isAbsolute(source) ? relative(root, source).replaceAll('\\', '/') : source),
    },
  }),
)

export default [clientConfig, ...hostConfigs]
