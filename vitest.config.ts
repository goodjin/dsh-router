import { defineConfig } from 'vitest/config'

/**
 * 只跑源码里的测试。dist/ 下是 tsc 的中间产物（dist/client）和宿主入口产物
 * （dist/entry.js），lib/ 下是打包结果（lib/client.js）——编译后的副本与产物
 * 不进测试集，免得同一断言失败两次。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['lib/**', 'dist/**', 'node_modules/**'],
  },
})
