import { SituationError } from '@fly-novel/initial-situation'
import { DevelopmentError, DevelopmentStore, kindSchema } from '@fly-novel/world-development'
import type { SpecificResolver } from '@fly-novel/world-specific'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../workspace/config.js'
import { createWorldDevelopmentResolvers, type WorldDevelopmentReferences } from './world-development-references.js'

export interface WorldSpecificReferences extends WorldDevelopmentReferences { development?: { agentId: string; store: DevelopmentStore } }
/** 绑定同世界各负责人持有的存储；调用方负责借用句柄生命周期。 */
export async function createWorldSpecificResolver(config: { workspaces: readonly WorldWorkspaceConfig[]; worldId: string } & WorldSpecificReferences): Promise<SpecificResolver> {
  const worlds = await validateWorldWorkspaceConfigs(config.workspaces); const world = worlds.find(item => item.worldId === config.worldId)
  if (!world) throw new Error('世界专有内容引用的世界不存在')
  const existing = await createWorldDevelopmentResolvers({ ...config, workspaces: worlds, worldId: world.worldId }); const development = config.development; const situation = config.situation
  if (development && (development.store.worldId !== world.worldId || !world.agents.some(item => item.agentId === development.agentId && item.writableRoot === development.store.rootDirectory))) throw new Error('世界发展规划引用与可信世界或负责人目录不匹配')
  return async (type, id, signal) => {
    signal?.throwIfAborted()
    try {
      if (type === 'situation-overview' || type === 'situation') {
        if (!situation) return undefined
        const value = type === 'situation-overview' ? await situation.store.readOverview(id, signal) : await situation.store.readSituation(id, signal)
        return { id: value.document.id, worldId: value.document.worldId, version: value.version }
      }
      if (type.startsWith('development-')) {
        const kind = kindSchema.safeParse(type.slice('development-'.length)); if (!kind.success || !development) return undefined
        const value = await development.store.readDocument(kind.data, id, signal)
        return { id: value.document.id, worldId: value.document.worldId, version: value.version }
      }
      return await existing.resolveReference(type, id, signal)
    } catch (error) {
      if ((error instanceof SituationError && error.code === 'SITUATION_NOT_FOUND') || (error instanceof DevelopmentError && error.code === 'DEVELOPMENT_NOT_FOUND')) return null
      throw error
    }
  }
}
