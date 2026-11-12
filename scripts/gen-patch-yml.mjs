#!/usr/bin/env node
// 生成 cordis.patch.yml：executor 静态预设行的 persona 文本从 src/host/prompts/unified.ts
// 的模板字面量逐字节提取（bundle.spec 逐字看守兜底），其余为固定结构。
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('..', import.meta.url) // worktree root
const unifiedSrc = readFileSync(new URL('src/host/prompts/unified.ts', root), 'utf8')
const match = unifiedSrc.match(/export const unifiedPrompt = `([\s\S]*)`\s*$/)
if (!match) throw new Error('unified.ts 里找不到 unifiedPrompt 模板字面量')
const persona = match[1]
if (!persona.endsWith('\n')) throw new Error('unified persona 应以换行结尾')

const indented = persona.split('\n').map((line) => (line === '' ? '' : ' '.repeat(16) + line)).join('\n')
// persona 以 \n 结尾 → split 后最后一个元素是 ''，映射成空行后需要剥掉（|- 块标量自带末尾换行语义）
const personaBlock = indented.replace(/\n$/, '')

const yml = `# @goodjin2/dsh-router 的挂载配置。
#
# 结构（契约依据 docs/research/r1-presets-tools.md / r2-sessions.md / r3-client-ui.md
# 与 v1.1 的 r4-dynamic-presets.md / r6-subagent-row.md 取证）：
#   - dsh-router-client：裸包名行——既把浏览器半边送进启动图（name 必须恰好等于
#     包名，带子路径的行不算浏览器行），也是宿主根服务行（dist/entry.js 组装
#     routerCore、问答瀑布监听、HTTP 路由、worker 类型存储与动态预设引擎）。
#     config 全部可缺省（volatile 默认值在宿主 schema 里，运行时另有防御性解析）。
#   - 一条静态预设行：dsh-router-executor（order 20，「执行者」）。2026-11-12 用户
#     裁定：主管/工作两条静态预设合并为单条执行者预设——组合与
#     src/host/presets/dynamic.ts 的 buildSupersetPlugins() 逐行逐字节一致（bundle.spec
#     看守），persona 与 prompts/unified.ts 逐字同步（身份中立，角色身份由身份卡
#     声明、权限由执行层 assertCallerRole 硬闸把关，preset 层不再分置角色）。
#     它服务：minimal-face 回退派发（builtin 类型与无类型分派）、cache 模式无分叉源
#     的回退创建路径、手动挑选。
#   - Router 预设（id 仍 dsh-router）运行时动态注册：默认提示词/默认模型来自
#     设置，默认值可编辑后 unregister+register 即时生效；静态 yml 行与动态注册
#     同 id 会撞 \\\`Duplicate agent preset\\\`（r4 §1），所以不放这里——静态兜底定义由
#     src/host/presets/dynamic.ts 的 staticRouterDefinition() 携带（persona 文本与
#     prompts/router.ts 同源，无第二份文本）。
#   - 旧会话兼容：dsh-router-supervisor / dsh-router-worker 两个旧 id 不在本文件，
#     启动时由插件动态注册同名别名（组合与 executor 完全一致、order 999、名称标注
#     「旧会话兼容」，失败仅告警）——旧执行会话（会话日志记录的 preset id 必须在册，
#     r4 §4）因此仍可重开；别名会出现在花名册尾部，属已向用户披露的取舍。
#   - persona 行 complete: true 整段替换默认提示词；executor 文本与
#     src/host/prompts/unified.ts 逐字同步（bundle.spec 看守），改一侧必须同步另一侧。
#     Router 的动态 persona 文本源自 defaults（缺省 prompts/router.ts）。
#   - delegation 组按 r6 §5 双宿主都绿的清单挂子代理工具行：
#     tool-subagent-control 裸行（0.2.2 起 list_agents 就在这行里，绝不单挂
#     ./list-agents 子路径行）+ tool-subagent（provider: spawn, maxDepth: 2）；
#     禁写 modelSelectionSettings / modelSelection / modelDiscovery / backgroundMode
#     四个跨版本死键。
#
# 改过任何行之后必须跑双核查（两个宿主都要绿）：
#   node /Users/good/github/dsh-plugins/scripts/check-host-rows.mjs dsh-router
#   node scripts/check-subrows.mjs

- insert:
    - id: dsh-router-client
      name: '@goodjin2/dsh-router'
    - id: dsh-router-executor-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: dsh-router-executor
        name: 执行者
        description: 统一执行者（组合与动态超集逐字节一致；身份由身份卡声明）
        order: 20
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |-
${personaBlock}
              complete: true

          # tools 行 role:'superset'：注册全部编排工具，角色闸在执行层按真实调用者
          # 过 assertCallerRole（权限矩阵不变）；与 buildSupersetPlugins 同款。
          - id: tools
            name: '@goodjin2/dsh-router/tools'
            config:
              role: superset
          - id: ask-user
            name: '@deepseek-ai/dsh-tool-ask-user'
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              applyPatch: false
          # 宿主必填（无默认；双版本 standard/ptc 均传 false），缺了整树回滚
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false
          # 执行支撑三件（2026-11-10 工具面补齐，与动态超集同配置）：没有 web，
          # 执行者会把「需要上网」的任务如实报成「没有合适的工具」。配置抄
          # superpowers 双宿主验证过的挂法。
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            config:
              fetch: true
              searchTimeoutMs: 60000
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
            config:
              allowParallelInProgress: true
          - id: tool-jobs
            name: '@deepseek-ai/dsh-tool-jobs'
          - id: delegation
            name: cordis:group
            group: true
            isolate:
              workflowEngine: true
            config:
              # 控制与发现工具；裸行无 config（该包两版本都不导出 Config）。
              # 0.2.2 起 list_agents 就在这行里，绝不再单挂 .../list-agents 行
              #（r6 §2：0.2.2 删了子路径导出，挂了=never started=整树回滚）。
              - id: tool-subagent-control
                name: '@deepseek-ai/dsh-tool-subagent-control'
              # 一次性进程内子代理（空会话起步，默认继承父路由）。
              # 不写 modelSelection*/modelDiscovery/backgroundMode（跨版本死键）；
              # maxDepth 2 允许二级派发（spawn 有 depthLimit 能力，挂载安全）。
              - id: tool-subagent
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent
                  maxDepth: 2
          - id: router-context
            name: '@goodjin2/dsh-router/context'
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              # 压缩引擎行是 Router 的任务描述引擎（2026-11-11 用户裁定流程）：
              # 与动态超集逐字节一致（组合等价是前缀缓存的前提）。行 id 保持
              # compaction-basic——只需组内唯一。
              - id: compaction-basic
                name: '@goodjin2/dsh-router/compaction'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
              - id: tool-result-pruner
                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
                config:
                  thresholdChars: 8192
                  headChars: 4096
                  tailChars: 1024
`

writeFileSync(new URL('cordis.patch.yml', root), yml)
console.log('written', yml.length, 'bytes')
