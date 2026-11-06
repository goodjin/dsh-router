/**
 * 内置 worker 模板（Config.templates 缺省值；模板定义独立成文件供 Config 与
 * entry 两处引用，避免循环依赖）。
 */

import type { WorkerTemplate } from '../shared/view-contract.ts'

export const BUILTIN_TEMPLATES: WorkerTemplate[] = [
  { templateId: 'coder', name: '编码', description: '在仓库里写代码、跑测试的执行者', role: 'worker' },
  { templateId: 'researcher', name: '调研', description: '查资料、读代码、出结论文档的执行者', role: 'worker' },
  { templateId: 'reviewer', name: '审查', description: '审查交付物与验收依据的执行者', role: 'worker' },
  { templateId: 'lead', name: '主管', description: '可继续拆分子任务的主管型', role: 'supervisor' },
]
