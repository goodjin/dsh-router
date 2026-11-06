/**
 * 文件系统适配器接口（计划 Task 3）。
 *
 * 文档存储的一切 IO 都经此接口注入：领域代码零 node 依赖、零宿主依赖，
 * 测试用内存实现，宿主侧（Part B）提供 node:fs/promises 的实现。
 */

/** 文档存储依赖的最小文件系统能力。 */
export interface FsAdapter {
  readFile(p: string): Promise<string>
  writeFile(p: string, content: string): Promise<void>
  /** 逐级建目录（等价 mkdir -p）。 */
  mkdirp(p: string): Promise<void>
  exists(p: string): Promise<boolean>
  readdir(p: string): Promise<string[]>
}
