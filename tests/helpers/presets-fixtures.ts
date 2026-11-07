/**
 * 动态预设测试样例（spawn-mode.spec 用；与 presets-dynamic.spec 内联样例同构，
 * 抽出共用以免第二处漂移）。
 */

import type { WorkerTypeRecord } from '../../src/shared/view-contract.ts'

export function workerType(patch: Partial<WorkerTypeRecord> = {}): WorkerTypeRecord {
  return {
    templateId: 'docs-writer',
    name: '文档写手',
    description: '写文档的执行者',
    role: 'worker',
    models: ['deepseek-official/deepseek-flash', 'minimax-cn/MiniMax-M3.1'],
    systemPrompt: '你是文档写手。\n',
    skills: ['superpowers'],
    enabled: true,
    origin: 'user',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}
