import { join } from 'node:path'
import { MapStore, MapStoreError } from '@fly-novel/map'
import { OrganizationStore, OrganizationStoreError } from '@fly-novel/organization'
import { HistoryStore, HistoryError } from '@fly-novel/history'
import { CharacterStore, CharacterRelationshipStore } from '@fly-novel/character'
import type { SituationReferenceResolver } from '@fly-novel/initial-situation'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../../world-init/workspace/config.js'

type Bound<T> = { agentId: string; store: T }
export interface SituationReferences { map?: Bound<MapStore>; organization?: Bound<OrganizationStore>; history?: Bound<HistoryStore>; characters?: Bound<CharacterStore>; relationships?: Bound<CharacterRelationshipStore> }

/** 借用同世界及负责人目录的存储；调用方负责句柄生命周期。 */
export async function createSituationReferenceResolver(config: { workspaces: readonly WorldWorkspaceConfig[]; worldId: string } & SituationReferences): Promise<SituationReferenceResolver> {
  const worlds = await validateWorldWorkspaceConfigs(config.workspaces); const world = worlds.find(item => item.worldId === config.worldId)
  if (!world) throw new Error('局势引用的世界不存在')
  const owner = (id: string) => { const entry = world.agents.find(item => item.agentId === id); if (!entry) throw new Error('局势引用负责人不属于该世界'); return entry.writableRoot }
  if (config.map && (config.map.store.boundWorldId !== world.worldId || config.map.store.rootDirectory !== owner(config.map.agentId))) throw new Error('地图引用世界或负责人不匹配')
  if (config.organization && (config.organization.store.worldId !== world.worldId || config.organization.store.rootDirectory !== owner(config.organization.agentId))) throw new Error('组织引用世界或负责人不匹配')
  if (config.history && (config.history.store.worldId !== world.worldId || config.history.store.rootDirectory !== owner(config.history.agentId))) throw new Error('历史引用世界或负责人不匹配')
  if (config.characters && config.characters.store.rootDirectory !== owner(config.characters.agentId)) throw new Error('人物引用负责人不匹配')
  if (config.relationships && (config.relationships.store.worldId !== world.worldId || config.relationships.store.rootDirectory !== join(owner(config.relationships.agentId), 'relationships'))) throw new Error('人物关系引用世界或负责人不匹配')
  return async (type, id, signal) => {
    signal?.throwIfAborted()
    try {
      if (type === 'history' && config.history) { const v = await config.history.store.readEvent(id, signal); return { id: v.document.id, worldId: v.document.worldId, version: v.version } }
      if (type === 'place' && config.map) { const v = await config.map.store.readPlace(id, signal); return { id: v.document.id, worldId: v.document.worldId, version: v.version } }
      if ((type === 'organization' || type === 'organization-relation') && config.organization) {
        const v = type === 'organization' ? await config.organization.store.readOrganization(id, signal) : await config.organization.store.readRelation(id, signal)
        return { id: v.document.id, worldId: v.document.worldId, version: v.version }
      }
      if (type === 'person' && config.characters) {
        const matches = await config.characters.store.query({}); signal?.throwIfAborted(); if (!matches.some(item => item.id === id)) return null
        const v = await config.characters.store.readVersioned(id); signal?.throwIfAborted(); return { id: v.document.metadata.id, worldId: world.worldId, version: v.version }
      }
      if (type === 'person-relation' && config.relationships) { const v = await config.relationships.store.read(id, signal); return { id: v.document.id, worldId: v.document.worldId, version: v.version } }
      return undefined
    } catch (error) {
      if ((error instanceof MapStoreError && error.code === 'MAP_NOT_FOUND') || (error instanceof OrganizationStoreError && error.code === 'ORG_NOT_FOUND') || (error instanceof HistoryError && error.code === 'HISTORY_NOT_FOUND') || (error instanceof Error && 'code' in error && error.code === 'CHARACTER_RELATION_NOT_FOUND')) return null
      throw error
    }
  }
}
