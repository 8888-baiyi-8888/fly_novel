import { MapStore } from '@fly-novel/map'
import { OrganizationStore, OrganizationStoreError } from '@fly-novel/organization'
import { CharacterStore } from '@fly-novel/character'
import type { HistoryReferenceResolver } from '@fly-novel/history'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../../world-init/workspace/config.js'
import { createOrganizationReferenceResolvers } from './organization-references.js'

/** 借用同世界负责人持有的存储，调用方负责保持句柄有效。 */
export async function createHistoryReferenceResolvers(config: {
  workspaces: readonly WorldWorkspaceConfig[]; worldId: string
  map?: { agentId: string; store: MapStore }; characters?: { agentId: string; store: CharacterStore }
  organization?: { agentId: string; store: OrganizationStore }
}): Promise<{ resolvePlace?: HistoryReferenceResolver; resolvePerson?: HistoryReferenceResolver; resolveOrganization?: HistoryReferenceResolver }> {
  const worlds = await validateWorldWorkspaceConfigs(config.workspaces)
  const world = worlds.find(item => item.worldId === config.worldId)
  if (!world) throw new Error('历史引用的世界配置不存在')
  const existing = await createOrganizationReferenceResolvers({ workspaces: worlds, worldId: world.worldId, map: config.map, characters: config.characters })
  const organization = config.organization
  if (organization && (organization.store.worldId !== world.worldId || !world.agents.some(item => item.agentId === organization.agentId && item.writableRoot === organization.store.rootDirectory))) throw new Error('组织引用与可信世界或负责人目录不匹配')
  const resolveOrganization: HistoryReferenceResolver | undefined = organization && (async (id, signal) => {
    try { const result = await organization.store.readOrganization(id, signal); return { id: result.document.id, worldId: result.document.worldId } }
    catch (error) { if (error instanceof OrganizationStoreError && error.code === 'ORG_NOT_FOUND') return null; throw error }
  })
  return { ...existing, ...(resolveOrganization ? { resolveOrganization } : {}) }
}
