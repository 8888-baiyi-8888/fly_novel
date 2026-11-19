import { MapStore, MapStoreError } from '@fly-novel/map'
import type { OrganizationReferenceResolver } from '@fly-novel/organization'
import { CharacterStore } from '@fly-novel/character'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../workspace/config.js'

/** 仅从已拥有的同世界服务提供组织引用核验，不重复打开服务或转交写入能力。 */
export async function createOrganizationReferenceResolvers(config: {
  workspaces: readonly WorldWorkspaceConfig[]
  worldId: string
  map?: { agentId: string; store: MapStore }
  characters?: { agentId: string; store: CharacterStore }
}): Promise<{ resolvePlace?: OrganizationReferenceResolver; resolvePerson?: OrganizationReferenceResolver }> {
  const worlds = await validateWorldWorkspaceConfigs(config.workspaces)
  const world = worlds.find(item => item.worldId === config.worldId)
  if (!world) throw new Error('组织引用的世界配置不存在')
  const owner = (id: string) => {
    const entry = world.agents.find(item => item.agentId === id)
    if (!entry) throw new Error('组织引用的负责人不属于该世界')
    return entry
  }
  const map = config.map; const characters = config.characters
  if (map && (map.store.boundWorldId !== world.worldId || map.store.rootDirectory !== owner(map.agentId).writableRoot)) throw new Error('地图服务与可信世界或负责人目录不匹配')
  if (characters && characters.store.rootDirectory !== owner(characters.agentId).writableRoot) throw new Error('角色服务与可信负责人目录不匹配')
  const resolvePlace: OrganizationReferenceResolver | undefined = map && (async (id, signal) => {
    try {
      const value = await map.store.readPlace(id, signal)
      return { id: value.document.id, worldId: value.document.worldId }
    } catch (error) { if (error instanceof MapStoreError && error.code === 'MAP_NOT_FOUND') return null; throw error }
  })
  const resolvePerson: OrganizationReferenceResolver | undefined = characters && (async (id, signal) => {
    signal?.throwIfAborted()
    const records = await characters.store.query({}); signal?.throwIfAborted()
    if (!records.some(item => item.id === id)) return null
    const result = await characters.store.read(id); signal?.throwIfAborted()
    if (result.metadata.id !== id) throw new Error('角色资料身份不匹配')
    return { id: result.metadata.id, worldId: world.worldId }
  })
  return { ...(resolvePlace ? { resolvePlace } : {}), ...(resolvePerson ? { resolvePerson } : {}) }
}
