import { FsError } from '@fly-novel/fs'
import type { FileSystem, FsTarget } from '@fly-novel/fs'

/**
 * 解析读取目标，并在读取或探测目标前限制到可信授权目录。
 * @param fs 当前执行作用域的文件后端。
 * @param workingDirectory 由可信调用方提供的读取授权根及相对路径基准。
 * @param requestedPath 模型提供的路径。
 * @param signal 取消信号。
 * @returns 根目录内的后端目标；不返回目标内容或记录观察。
 * @throws 授权根无效、路径越界、解析失败或取消时拒绝。
 */
export async function resolveReadTarget(fs: FileSystem, workingDirectory: string, requestedPath: string, signal: AbortSignal): Promise<FsTarget> {
  if (!workingDirectory.trim() || !requestedPath.trim()) throw new Error('读取路径和授权目录必须非空')
  const root = await fs.resolve(workingDirectory, { signal })
  const rootInfo = await fs.stat(root, signal)
  if (!rootInfo || rootInfo.type !== 'directory') throw new Error('读取授权目录不存在或不是目录')
  let target: FsTarget
  try {
    target = await fs.resolve(requestedPath, { cwd: root.displayPath, signal })
  } catch (error) {
    if (signal.aborted) throw new FsError('读取目标解析已取消', 'FS_ABORTED', { cause: error })
    throw new FsError('无法解析读取目标', 'FS_IO_ERROR', { cause: error })
  }
  if (!fs.contains(root, target)) throw new FsError('文件路径超出读取授权范围', 'FS_PERMISSION_DENIED')
  return target
}
