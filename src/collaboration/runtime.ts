/**
 * 轻量协作运行时 createCollaborationRuntime（计划 Task 2B，Layer 3）。
 *
 * 根服务 routerCollaboration 的组装点：一次解析 dataDir、创建一条 RecordStore 与一条
 * RoleStore 单实例，返回 {records, roles, dataDir}。构造是纯内存的——不扫描、不建目录、
 * 不执行任何业务引擎；存储在其上真正做 IO 时才碰文件系统。不 import 旧 routerCore/
 * scheduler/adjudicator/adoption/budgets/memory 后台摘要/任务控制路由，不拖遗留依赖树。
 *
 * dataDir 是插件数据根（不是 collaboration 子目录）；RecordStore/RoleStore 内部各自拼一次
 * collaboration/roles 命名空间（见 records.ts/roles.ts）。默认 DSH_HOME/router，resolve 一次。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { createRecordStore } from './records.ts'
import { createRoleStore } from './roles.ts'
import type { RecordStore, RoleStore } from './types.ts'

/** 根服务对外暴露的面（tools/context 行经 inject ['routerCollaboration'] 取用）。 */
export interface CollaborationRuntime {
  records: RecordStore
  roles: RoleStore
  dataDir: string
}

/**
 * 解析插件数据根：显式 dataDir 直通；缺省 DSH_HOME ?? homedir()/.dsh 下的 router。
 * resolve 一次，调用方拿到的是最终绝对/相对路径原样（不在此处做 resolve 规整，
 * 与旧 root-config 的 stringOr 口径一致：空串/非串回默认）。
 */
function resolveDataDir(raw: unknown): string {
  if (typeof raw === 'string' && raw.trim() !== '') return raw
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'router')
}

/**
 * 创建协作运行时。纯内存构造：只建存储单实例，不扫描/建目录/起引擎。
 * 同一 dataDir 的多次调用各自持有独立存储实例（根服务单行实例化，跨调用共享由
 * provide 的单例保证，不在此层做缓存）。
 */
export function createCollaborationRuntime(input: { dataDir?: string } = {}): CollaborationRuntime {
  const dataDir = resolveDataDir(input?.dataDir)
  const records = createRecordStore(dataDir)
  const roles = createRoleStore(dataDir)
  return { records, roles, dataDir }
}
