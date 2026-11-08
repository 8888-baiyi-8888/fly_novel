/** 文件修改模式，与上游文件策略一致。 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 由可信调用方构建的执行策略；路径属于执行后端所在的文件系统。 */
export interface SandboxExecutionPolicy {
  mode: SandboxMode
  workspaceRoot: string
  additionalWritableRoots?: readonly string[]
}

export { canonicalPath, workspaceWritableRoots, writableRoots, SandboxInvalidRootError } from './roots.js'
