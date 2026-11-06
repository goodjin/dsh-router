/**
 * 任务文档 TaskDocStore 与任务书渲染测试（计划 Task 3）。
 *
 * 覆盖计划「步骤」列出的断言集合：v1 落盘且二次 init 拒绝（doc-exists）；
 * supplement 生成 v2 且 v1 字节不变；result.md 字段齐（摘要/交付物/验收依据/
 * 遗留问题/完成时间）；路径拼接含版本。另加：任务书九节顺序与无代码块、
 * progress 覆写、readDoc 缺文件抛 doc-not-found。IO 全部走内存 FsAdapter。
 */

import { describe, expect, it } from 'vitest'
import { LedgerError } from '../src/host/ledger/errors.ts'
import { renderTaskBook } from '../src/host/docs/render.ts'
import { TaskDocStore } from '../src/host/docs/task-docs.ts'
import type { FsAdapter } from '../src/shared/fs-adapter.ts'
import type { TaskRecord, TaskResult } from '../src/shared/types.ts'

/** 内存文件系统：Map 存文件，路径精确匹配。 */
class MemoryFs implements FsAdapter {
  files = new Map<string, string>()

  async readFile(p: string): Promise<string> {
    const content = this.files.get(p)
    if (content === undefined) throw new Error(`ENOENT: ${p}`)
    return content
  }

  async writeFile(p: string, content: string): Promise<void> {
    this.files.set(p, content)
  }

  async mkdirp(): Promise<void> {}

  async exists(p: string): Promise<boolean> {
    return this.files.has(p)
  }

  async readdir(p: string): Promise<string[]> {
    const prefix = p.endsWith('/') ? p : `${p}/`
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
  }
}

/** 测试任务记录（docVersion=1 的最小形状）。 */
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'T-001',
    title: '实现登录页',
    goal: '交付可用的登录页',
    acceptance: ['表单可提交', '错误提示可见'],
    constraints: ['只用现有组件库'],
    projectId: 'proj-1',
    cwd: '/tmp/proj',
    role: 'worker',
    templateId: 'coder',
    parentId: 'T-000',
    dependsOn: ['T-000'],
    status: 'running',
    docVersion: 1,
    acceptancePolicy: 'auto',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

/** 测试完成结果。 */
function result(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    summary: '登录页完成并通过手测',
    docRef: 'tasks/T-001/result.md',
    deliverables: ['src/login.tsx'],
    acceptanceEvidence: '手测记录见会话 sess-9',
    openIssues: ['移动端布局待调'],
    completedAt: 1700000000000,
    ...overrides,
  }
}

const ROOT = '/memory-root'

describe('renderTaskBook：九节、顺序、纯 Markdown', () => {
  const SECTIONS = ['目标', '背景与范围', '约束', '验收条件', '指派', '父任务与依赖', '输入材料', '来源引用', '文档版本']

  it('九节按计划顺序出现，标题行齐全', () => {
    const book = renderTaskBook(task())
    const positions = SECTIONS.map((s) => book.indexOf(`## ${s}`))
    positions.forEach((p, i) => expect(p, `节「${SECTIONS[i]}」应存在`).toBeGreaterThan(-1))
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('正文覆盖任务字段与 inputs，全文无代码块', () => {
    const book = renderTaskBook(task(), {
      materials: ['需求链接 https://example.com/t/1'],
      memoryRefs: ['项目约定：禁用 any'],
      sourceRef: '会话 sess-1 消息 42',
    })
    expect(book).toContain('# 任务书 T-001')
    expect(book).toContain('交付可用的登录页')
    expect(book).toContain('proj-1')
    expect(book).toContain('/tmp/proj')
    expect(book).toContain('只用现有组件库')
    expect(book).toContain('表单可提交')
    expect(book).toContain('worker')
    expect(book).toContain('coder')
    expect(book).toContain('T-000')
    expect(book).toContain('需求链接 https://example.com/t/1')
    expect(book).toContain('项目约定：禁用 any')
    expect(book).toContain('会话 sess-1 消息 42')
    expect(book).toContain('v1')
    expect(book).not.toContain('```')
  })

  it('缺省可选内容时渲染「无」占位，不缺节', () => {
    const book = renderTaskBook(task({ parentId: undefined, dependsOn: [], templateId: undefined }), {})
    expect(book).not.toContain('```')
    for (const s of ['父任务与依赖', '输入材料', '来源引用']) {
      expect(book).toContain(`## ${s}`)
    }
  })
})

describe('TaskDocStore.initTask', () => {
  it('v1 落盘到 tasks/<ID>/task.v1.md，返回路径', async () => {
    const store = new TaskDocStore(ROOT, new MemoryFs())
    const book = renderTaskBook(task())
    const path = await store.initTask(task(), book)
    expect(path).toBe(`${ROOT}/tasks/T-001/task.v1.md`)
  })

  it('二次 init 同一任务抛 doc-exists', async () => {
    const store = new TaskDocStore(ROOT, new MemoryFs())
    const t = task()
    await store.initTask(t, renderTaskBook(t))
    try {
      await store.initTask(t, renderTaskBook(t))
      expect.fail('应抛 doc-exists')
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerError)
      expect((err as LedgerError).code).toBe('doc-exists')
    }
  })
})

describe('TaskDocStore.supplement', () => {
  it('生成 v2：含「v 2 补充」节与原文，v1 字节不变', async () => {
    const fs = new MemoryFs()
    const store = new TaskDocStore(ROOT, fs)
    const t = task()
    const v1Path = await store.initTask(t, renderTaskBook(t))
    const v1Bytes = fs.files.get(v1Path)
    if (v1Bytes === undefined) throw new Error('v1 应已落盘')
    const v2 = await store.supplement('T-001', 1, ['补：移动端也要支持'])
    expect(v2).toBe(2)
    const v2Path = `${ROOT}/tasks/T-001/task.v2.md`
    const v2Content = fs.files.get(v2Path)
    if (v2Content === undefined) throw new Error('v2 应已落盘')
    expect(v2Content).toBeDefined()
    expect(v2Content).toContain('## v2 补充')
    expect(v2Content).toContain('补：移动端也要支持')
    expect(v2Content).toContain(v1Bytes)
    expect(fs.files.get(v1Path)).toBe(v1Bytes)
  })

  it('同一 fromVersion 二次 supplement 抛 doc-exists；从 v2 再补得 v3', async () => {
    const store = new TaskDocStore(ROOT, new MemoryFs())
    await store.initTask(task(), '正文')
    await store.supplement('T-001', 1, ['第一次补充'])
    await expect(store.supplement('T-001', 1, ['重复补充'])).rejects.toMatchObject({ code: 'doc-exists' })
    const v3 = await store.supplement('T-001', 2, ['第二次补充'])
    expect(v3).toBe(3)
  })

  it('fromVersion 文件不存在抛 doc-not-found', async () => {
    const store = new TaskDocStore(ROOT, new MemoryFs())
    await store.initTask(task(), '正文')
    await expect(store.supplement('T-001', 9, ['凭空补充'])).rejects.toMatchObject({ code: 'doc-not-found' })
  })
})

describe('TaskDocStore.writeProgress / writeResult', () => {
  it('progress.md 写入且覆写生效', async () => {
    const fs = new MemoryFs()
    const store = new TaskDocStore(ROOT, fs)
    await store.writeProgress('T-001', '跑了一半')
    await store.writeProgress('T-001', '跑完九成')
    expect(fs.files.get(`${ROOT}/tasks/T-001/progress.md`)).toBe('跑完九成')
  })

  it('result.md 五字段齐全，返回路径', async () => {
    const fs = new MemoryFs()
    const store = new TaskDocStore(ROOT, fs)
    const path = await store.writeResult('T-001', result())
    expect(path).toBe(`${ROOT}/tasks/T-001/result.md`)
    const content = fs.files.get(path) ?? ''
    expect(content).toContain('登录页完成并通过手测')
    expect(content).toContain('src/login.tsx')
    expect(content).toContain('手测记录见会话 sess-9')
    expect(content).toContain('移动端布局待调')
    expect(content).toContain(new Date(1700000000000).toISOString())
    expect(content).not.toContain('```')
  })
})

describe('docPath / readDoc', () => {
  it('路径拼接含版本：task.v2.md；无版本名落到 <name>.md', () => {
    const store = new TaskDocStore(ROOT, new MemoryFs())
    expect(store.docPath('T-001', 'task', 2)).toBe(`${ROOT}/tasks/T-001/task.v2.md`)
    expect(store.docPath('T-001', 'task', 1)).toBe(`${ROOT}/tasks/T-001/task.v1.md`)
    expect(store.docPath('T-001', 'result')).toBe(`${ROOT}/tasks/T-001/result.md`)
    expect(store.docPath('T-001', 'progress')).toBe(`${ROOT}/tasks/T-001/progress.md`)
  })

  it('readDoc 读回版本文件；缺文件抛 doc-not-found', async () => {
    const store = new TaskDocStore(ROOT, new MemoryFs())
    await store.initTask(task(), '任务书正文')
    expect(await store.readDoc('T-001', 'task', 1)).toBe('任务书正文')
    try {
      await store.readDoc('T-001', 'task', 7)
      expect.fail('应抛 doc-not-found')
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerError)
      expect((err as LedgerError).code).toBe('doc-not-found')
    }
  })
})
