import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { OrganizationStore, type OrganizationReferenceResolver } from '@fly-novel/organization'
import type { WorldWorkspaceConfig } from '../workspace/config.js'

/** 可信应用持有组织存储；引用解析器及底层资源由装配方绑定。 */
export class SharedOrganizationStorage {
  private opening?: Promise<OrganizationStore>
  private closing?: Promise<void>
  private closed = false
  private disposeStore?: () => Promise<void>

  constructor(private readonly world: WorldWorkspaceConfig, private readonly ownerId: string,
    private readonly references: () => Promise<{ resolvePlace?: OrganizationReferenceResolver; resolvePerson?: OrganizationReferenceResolver }>) {}

  get(): Promise<OrganizationStore> {
    if (this.closed) return Promise.reject(new Error('共享组织存储已关闭'))
    if (!this.opening) {
      const opening = this.open()
      this.opening = opening
      void opening.catch(error => { if (!(error instanceof AggregateError) && this.opening === opening) this.opening = undefined })
    }
    return this.opening
  }

  private async open(): Promise<OrganizationStore> {
    const owner = this.world.agents.find(agent => agent.agentId === this.ownerId)
    if (!owner) throw new Error('组织负责人不属于该世界')
    const references = await this.references()
    const context = new Context()
    const backend = context.plugin(LocalFileSystem, { cwd: this.world.readRoot })
    try {
      await backend
      const store = await OrganizationStore.open({ fs: context.fs, root: owner.writableRoot, worldId: this.world.worldId, access: 'read-write', phase: 'initialization', singleWriterProcess: true, ...references })
      this.disposeStore = async () => { await store.close(); await backend.dispose() }
      return store
    } catch (error) {
      try { await backend.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], '共享组织存储打开和清理失败') }
      throw error
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true
      this.closing = (async () => {
        if (this.opening) { try { await this.opening } catch (error) { if (error instanceof AggregateError) throw error } }
        await this.disposeStore?.()
      })()
    }
    return this.closing
  }
}
