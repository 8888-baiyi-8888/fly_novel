import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore } from '@fly-novel/map'
import type { WorldWorkspaceConfig } from '../workspace/config.js'

/** 由可信世界装配持有的地图存储；借用者不得关闭返回的句柄。 */
export class SharedMapStorage {
  private opening?: Promise<MapStore>
  private closing?: Promise<void>
  private closed = false

  constructor(private readonly world: WorldWorkspaceConfig, private readonly ownerId: string) {}

  /** 并发调用共享同一打开过程；打开失败后可再次尝试。 */
  get(): Promise<MapStore> {
    if (this.closed) return Promise.reject(new Error('共享地图存储已关闭'))
    if (!this.opening) {
      const opening = this.open()
      this.opening = opening
      void opening.catch(error => { if (!(error instanceof AggregateError) && this.opening === opening) this.opening = undefined })
    }
    return this.opening
  }

  private async open(): Promise<MapStore> {
    const owner = this.world.agents.find(agent => agent.agentId === this.ownerId)
    if (!owner) throw new Error('地图负责人不属于该世界')
    const context = new Context()
    const backend = context.plugin(LocalFileSystem, { cwd: this.world.readRoot })
    try {
      await backend
      const store = await MapStore.open({ fs: context.fs, root: owner.writableRoot, worldId: this.world.worldId, access: 'read-write', singleWriterProcess: true })
      this.disposeStore = async () => { await store.close(); await backend.dispose() }
      return store
    } catch (error) {
      try { await backend.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], '共享地图存储打开和清理失败') }
      throw error
    }
  }

  private disposeStore?: () => Promise<void>

  /** 停止新借用，等待打开完成并关闭已打开的存储与文件后端。 */
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true
      this.closing = (async () => {
        if (this.opening) {
          try { await this.opening } catch (error) { if (error instanceof AggregateError) throw error }
        }
        await this.disposeStore?.()
      })()
    }
    return this.closing
  }
}
