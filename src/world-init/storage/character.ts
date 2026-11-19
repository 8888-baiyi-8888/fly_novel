import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CharacterStore, CharacterRelationshipStore } from '@fly-novel/character'
import type { WorldWorkspaceConfig } from '../workspace/config.js'

export interface SharedCharacterHandles {
  readonly store: CharacterStore
  readonly relationships: CharacterRelationshipStore
  resolvePerson(id: string, signal?: AbortSignal): Promise<{ id: string; worldId: string; name: string } | null>
}

/** 世界应用持有人物和关系存储，借用者不得关闭。 */
export class SharedCharacterStorage {
  private opening?: Promise<SharedCharacterHandles>
  private closing?: Promise<void>
  private closed = false

  constructor(private readonly world: WorldWorkspaceConfig, private readonly ownerId: string, private readonly initialize: boolean) {}

  get(): Promise<SharedCharacterHandles> {
    if (this.closed) return Promise.reject(new Error('共享人物存储已关闭'))
    if (!this.opening) {
      const opening = this.open()
      this.opening = opening
      // 人物初始化可能已创建索引；失败后不盲目重试或再次初始化。
    }
    return this.opening
  }

  private async open(): Promise<SharedCharacterHandles> {
    const owner = this.world.agents.find(item => item.agentId === this.ownerId)
    if (!owner) throw new Error('人物负责人不属于该世界')
    const store = await CharacterStore.open(owner.writableRoot, this.initialize)
    try {
      const root = join(owner.writableRoot, 'relationships')
      await mkdir(root, { recursive: true })
      const resolvePerson = async (id: string, signal?: AbortSignal) => {
        signal?.throwIfAborted()
        const records = await store.query({})
        signal?.throwIfAborted()
        if (!records.some(item => item.id === id)) return null
        const item = await store.read(id)
        signal?.throwIfAborted()
        return { id: item.metadata.id, name: item.metadata.name, worldId: this.world.worldId }
      }
      const relationships = await CharacterRelationshipStore.open({ root, worldId: this.world.worldId, phase: 'initialization', singleWriterProcess: true, resolvePerson })
      return { store, relationships, resolvePerson }
    } catch (error) {
      try { await store.close() } catch (cleanup) { throw new AggregateError([error, cleanup], '共享人物存储打开和清理失败') }
      throw error
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true
      this.closing = (async () => {
        if (!this.opening) return
        let handles: SharedCharacterHandles
        try { handles = await this.opening } catch (error) { if (error instanceof AggregateError) throw error; return }
        await handles.relationships.close()
        await handles.store.close()
      })()
    }
    return this.closing
  }
}
