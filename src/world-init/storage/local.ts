import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import type { FileSystem } from '@fly-novel/fs'
import { SharedResource } from './resource.js'

/** 按需创建文件后端和业务存储，关闭时先等待存储再释放后端。 */
export function sharedLocalStore<T extends { close(): Promise<void> }>(cwd: string, open: (fs: FileSystem) => Promise<T>): SharedResource<T> {
  return new SharedResource(async () => {
    const context = new Context()
    const backend = context.plugin(LocalFileSystem, { cwd })
    try {
      await backend
      const value = await open(context.fs)
      return { value, close: async () => { await value.close(); await backend.dispose() } }
    } catch (error) {
      try { await backend.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], '共享存储打开和清理失败') }
      throw error
    }
  })
}
