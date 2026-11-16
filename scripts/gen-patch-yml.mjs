#!/usr/bin/env node
// 生成 cordis.patch.yml（轻量协作版，计划 Task 2B）。
//
// 单一静态预设 dsh-router/Router：persona 的 complete 提示词来自 collaborationPrompt
// 的**实际导出**（Node TS stripping 直接 import src/collaboration/prompt.ts，纯静态字符串，
// 无类型/无副作用），不再正则解析旧 unifiedPrompt。其余为小型固定定义：七条协作工具行
// （@goodjin2/dsh-router/tools，无 role 配置）+ DSH 原生执行/用户提问/项目指令/默认压缩/
// 子代理控制。delegation 组沿用已双宿主验证过的隔离结构（tool-subagent-control 裸行 +
// tool-subagent provider spawn/toolName subagent/maxDepth 2），不挂旧动态服务。
//
// 改过任何行之后必须跑双核查（两个宿主都要绿）：
//   node /Users/good/github/dsh-plugins/scripts/check-host-rows.mjs dsh-router
//   node scripts/check-subrows.mjs

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)

// 实际导出的协作提示词（单一来源；Node 24 原生 TS stripping）。
const { collaborationPrompt } = await import(new URL('src/collaboration/prompt.ts', root))
if (typeof collaborationPrompt !== 'string' || collaborationPrompt.length === 0) {
  throw new Error('collaborationPrompt 未从 src/collaboration/prompt.ts 导出')
}
if (collaborationPrompt.includes('{{') || collaborationPrompt.includes('${')) {
  throw new Error('collaborationPrompt 不得含宿主插值语法（{{ 或 ${）')
}

// persona prefix 以 |- 块标量承载：按 16 空格缩进；|- 自带末尾换行语义，剥掉源串末尾换行。
const normalized = collaborationPrompt.endsWith('\n') ? collaborationPrompt.slice(0, -1) : collaborationPrompt
const indented = normalized.split('\n').map((line) => (line === '' ? '' : ' '.repeat(16) + line)).join('\n')
const personaBlock = indented

const yml = `# @goodjin2/dsh-router 的挂载配置（轻量协作版，计划 Task 2B）。
#
# 结构：
#   - dsh-router-client：裸包名行——既把浏览器半边送进启动图（name 必须恰好等于包名），
#     也是宿主根服务行（dist/entry.js 提供 routerCollaboration：一条 RecordStore + 一条
#     RoleStore 单实例）。config 全部可缺省（缺省 DSH_HOME/router）。
#   - 一条静态预设行 dsh-router/Router（@deepseek-ai/dsh-agent-preset）：
#     · persona complete:true，prefix 即 collaborationPrompt 单一来源（生成脚本实际导入）；
#     · tools 行 @goodjin2/dsh-router/tools 注册七条协作工具（无 role 配置/角色闸）；
#     · agent-instructions 项目指令、tool-bash/fs/fs-search/web/todo/jobs 原生执行、
#       tool-ask-user 用户提问、compaction 组默认压缩、delegation 组子代理控制
#       （tool-subagent-control 裸行 + tool-subagent provider spawn/toolName subagent/maxDepth 2）；
#     · 无旧 executor/supervisor/worker 别名、无 perrole 插件、无动态预设引擎。
#
# 改过任何行之后必须跑双核查（两个宿主都要绿）：
#   node /Users/good/github/dsh-plugins/scripts/check-host-rows.mjs dsh-router
#   node scripts/check-subrows.mjs

- insert:
    - id: dsh-router-client
      name: '@goodjin2/dsh-router'
    - id: dsh-router-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: dsh-router
        name: Router
        description: 模型主导的团队协作入口（Router 接任务、主管组队、成员执行；记录与通知走 DSH 原生能力）
        order: 30
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |-
${personaBlock}
              complete: true

          # 七条协作工具（记录 CRUD + 角色模板）；无 role 配置，角色闸已退役。
          - id: tools
            name: '@goodjin2/dsh-router/tools'
          # 协作上下文行（官方 systemPrompt.context：当前会话 ID + 协作目录 + 工具清单）。
          - id: router-context
            name: '@goodjin2/dsh-router/context'
            config:
              order: 100
          # 项目指令（宿主原生 CLAUDE.md/AGENTS.md 注入）。
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          # 原生执行工具。
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              applyPatch: false
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false
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
          # 用户提问（宿主原生浮窗）。
          - id: ask-user
            name: '@deepseek-ai/dsh-tool-ask-user'
          # 子代理控制（宿主原生）：控制与发现 + 一次性进程内子代理（spawn，maxDepth 2）。
          - id: delegation
            name: cordis:group
            group: true
            isolate:
              workflowEngine: true
            config:
              - id: tool-subagent-control
                name: '@deepseek-ai/dsh-tool-subagent-control'
              - id: tool-subagent-list-agents
                name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
              - id: tool-subagent
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent
                  maxDepth: 2
          # 默认压缩（宿主原生，非旧 @goodjin2/dsh-router/compaction）。
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
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
