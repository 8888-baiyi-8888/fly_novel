import { SituationStore, SituationError } from '@fly-novel/initial-situation'
import type { DevelopmentResolver, SituationResolver } from '@fly-novel/world-development'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../../world-init/workspace/config.js'
import { createSituationReferenceResolver, type SituationReferences } from './initial-situation-references.js'

export interface WorldDevelopmentReferences extends SituationReferences { situation?: { agentId: string; store: SituationStore } }
/** 借用同世界负责人持有的局势及其他存储；不转移句柄所有权。 */
export async function createWorldDevelopmentResolvers(config: { workspaces: readonly WorldWorkspaceConfig[]; worldId: string } & WorldDevelopmentReferences): Promise<{ resolveReference: DevelopmentResolver; resolveSituation?: SituationResolver }> {
  const worlds = await validateWorldWorkspaceConfigs(config.workspaces); const world = worlds.find(item => item.worldId === config.worldId)
  if (!world) throw new Error('世界发展规划引用的世界不存在')
  const resolveReference = await createSituationReferenceResolver({ ...config, workspaces: worlds, worldId: world.worldId })
  const situation = config.situation
  if (situation && (situation.store.worldId !== world.worldId || !world.agents.some(item => item.agentId === situation.agentId && item.writableRoot === situation.store.rootDirectory))) throw new Error('局势引用与可信世界或负责人目录不匹配')
  const resolveSituation: SituationResolver | undefined = situation && (async (overviewId, situationId, signal) => {
    try {
      const overview = await situation.store.readOverview(overviewId, signal)
      if (!situationId) return { worldId: overview.document.worldId, overviewId: overview.document.id, situationId: null, version: overview.version }
      const item = await situation.store.readSituation(situationId, signal)
      if (item.document.overviewId !== overview.document.id) return null
      return { worldId: item.document.worldId, overviewId: item.document.overviewId, situationId: item.document.id, version: item.version }
    } catch (error) { if (error instanceof SituationError && error.code === 'SITUATION_NOT_FOUND') return null; throw error }
  })
  return { resolveReference, ...(resolveSituation ? { resolveSituation } : {}) }
}
