/**
 * 测试共享：造一条 TaskRecord（字段全有、单改差异）。
 */

import type { TaskRecord } from '../../src/shared/types.ts'

let seq = 0

export function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  seq += 1
  const now = 1700000000000 + seq
  return {
    id: patch.id ?? `T-${String(seq).padStart(3, '0')}`,
    title: patch.title ?? '示例任务',
    goal: patch.goal ?? '把事情做完',
    acceptance: patch.acceptance ?? ['有测试'],
    constraints: patch.constraints ?? [],
    projectId: patch.projectId ?? 'ws-1',
    cwd: patch.cwd ?? '/tmp/proj',
    role: patch.role ?? 'worker',
    templateId: patch.templateId ?? 'coder',
    parentId: patch.parentId,
    dependsOn: patch.dependsOn ?? [],
    sessionId: patch.sessionId,
    status: patch.status ?? 'queued',
    progress: patch.progress,
    retryCount: patch.retryCount,
    docVersion: patch.docVersion ?? 1,
    acceptancePolicy: patch.acceptancePolicy ?? 'auto',
    createdAt: patch.createdAt ?? now,
    updatedAt: patch.updatedAt ?? now,
    result: patch.result,
  }
}
