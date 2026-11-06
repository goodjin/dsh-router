/**
 * 注入式文件系统适配面（与实施计划 Task 3 同一接口约定）。
 *
 * 领域核心（账本 / 任务文档 / 记忆）不 import 宿主专有包：所有磁盘访问都经此
 * 接口注入——测试用内存实现（tests/helpers/mem-fs.ts），宿主集成层用 node:fs
 * 实现后传入。客户端半边（src/client/**）不使用它。
 *
 * 注：main 骨架尚无 src/shared/fs-adapter.ts（Part A 在另一 worktree 实现中）。
 * 本文件按计划 Task 3 的接口形状在本 worktree 新建，两边内容一致，合并即重合。
 */

export interface FsAdapter {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  mkdirp(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  readdir(path: string): Promise<string[]>
}
