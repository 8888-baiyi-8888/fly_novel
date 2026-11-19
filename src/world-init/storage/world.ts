import { HistoryStore } from '@fly-novel/history'
import { SituationStore } from '@fly-novel/initial-situation'
import { DevelopmentStore } from '@fly-novel/world-development'
import { SpecificStore } from '@fly-novel/world-specific'
import type { WorldWorkspaceConfig } from '../workspace/config.js'
import { SharedMapStorage } from './map.js'
import { SharedOrganizationStorage } from './organization.js'
import { SharedCharacterStorage } from './character.js'
import { sharedLocalStore } from './local.js'
import { createOrganizationReferenceResolvers } from './organization-references.js'
import { createHistoryReferenceResolvers } from './history-references.js'
import { createSituationReferenceResolver, type SituationReferences } from './initial-situation-references.js'
import { createWorldDevelopmentResolvers, type WorldDevelopmentReferences } from './world-development-references.js'
import { createWorldSpecificResolver, type WorldSpecificReferences } from './world-specific-references.js'

type OrganizationRefs = Pick<Parameters<typeof createOrganizationReferenceResolvers>[0], 'map' | 'characters'>
type HistoryRefs = Pick<Parameters<typeof createHistoryReferenceResolvers>[0], 'map' | 'characters' | 'organization'>
type CreatorRefs = { map?: OrganizationRefs['map']; organization?: HistoryRefs['organization'] }
type Owner<T> = { agentId: string; references?: T }

/** 可信应用使用已校验的世界配置创建共享存储所有者。 */
export function createWorldStorage(worlds: readonly WorldWorkspaceConfig[], world: WorldWorkspaceConfig, config: {
  singleWriterProcess: true
  mapConfig?: { agentId: string }
  creator?: Owner<CreatorRefs> & { initializeCharacters: boolean }
  organizationConfig?: Owner<OrganizationRefs>
  historyConfig?: Owner<HistoryRefs>
  situationConfig?: Owner<SituationReferences>
  developmentConfig?: Owner<WorldDevelopmentReferences>
  specificConfig?: Owner<WorldSpecificReferences>
}) {
  if (config.singleWriterProcess !== true) throw new Error('必须确保同一世界仅由一个可信应用进程写入')
  const { mapConfig, creator, organizationConfig, historyConfig, situationConfig, developmentConfig, specificConfig } = config
  const sharedMap = mapConfig ? new SharedMapStorage(world, mapConfig.agentId) : undefined
  if (sharedMap && (creator?.references?.map || organizationConfig?.references?.map || historyConfig?.references?.map || situationConfig?.references?.map || developmentConfig?.references?.map || specificConfig?.references?.map)) throw new Error('共享地图与外部地图引用不能同时配置')
  const sharedCharacters = creator ? new SharedCharacterStorage(world, creator.agentId, creator.initializeCharacters) : undefined
  if (sharedCharacters && (organizationConfig?.references?.characters || historyConfig?.references?.characters || situationConfig?.references?.characters || situationConfig?.references?.relationships || developmentConfig?.references?.characters || developmentConfig?.references?.relationships || specificConfig?.references?.characters || specificConfig?.references?.relationships)) throw new Error('共享人物与外部人物引用不能同时配置')
  const sharedOrganization = organizationConfig ? new SharedOrganizationStorage(world, organizationConfig.agentId, async () => {
    const map = sharedMap && mapConfig ? { agentId: mapConfig.agentId, store: await sharedMap.get() } : undefined
    const references = await createOrganizationReferenceResolvers({ ...organizationConfig!.references, ...(map ? { map } : {}), workspaces: worlds, worldId: world.worldId })
    return { ...references, ...(sharedCharacters && creator ? { resolvePerson: async (id: string, signal?: AbortSignal) => {
      const characters = { agentId: creator!.agentId, store: (await sharedCharacters.get()).store }
      const resolver = await createOrganizationReferenceResolvers({ characters, workspaces: worlds, worldId: world.worldId })
      if (!resolver.resolvePerson) throw new Error('人物引用解析器不可用')
      return resolver.resolvePerson(id, signal)
    } } : {}) }
  }) : undefined
  if (sharedOrganization && (creator?.references?.organization || historyConfig?.references?.organization || situationConfig?.references?.organization || developmentConfig?.references?.organization || specificConfig?.references?.organization)) throw new Error('共享组织与外部组织引用不能同时配置')
  if (historyConfig && (situationConfig?.references?.history || developmentConfig?.references?.history || specificConfig?.references?.history)) throw new Error('共享历史与外部历史引用不能同时配置')
  const sharedHistory = historyConfig ? sharedLocalStore(world.readRoot, async fs => {
    const owner = world.agents.find(item => item.agentId === historyConfig!.agentId)!
    const map = sharedMap && mapConfig ? { agentId: mapConfig.agentId, store: await sharedMap.get() } : undefined
    const organization = sharedOrganization && organizationConfig ? { agentId: organizationConfig.agentId, store: await sharedOrganization.get() } : undefined
    const characters = sharedCharacters && creator ? { agentId: creator.agentId, store: (await sharedCharacters.get()).store } : undefined
    const references = await createHistoryReferenceResolvers({ ...historyConfig!.references, ...(map ? { map } : {}), ...(organization ? { organization } : {}), ...(characters ? { characters } : {}), workspaces: worlds, worldId: world.worldId })
    return HistoryStore.open({ fs, root: owner.writableRoot, worldId: world.worldId, access: 'read-write', phase: 'initialization', singleWriterProcess: true, ...references })
  }) : undefined
  if (situationConfig && (developmentConfig?.references?.situation || specificConfig?.references?.situation)) throw new Error('共享局势与外部局势引用不能同时配置')
  const sharedSituation = situationConfig ? sharedLocalStore(world.readRoot, async fs => {
    const owner = world.agents.find(item => item.agentId === situationConfig!.agentId)!
    const map = sharedMap && mapConfig ? { agentId: mapConfig.agentId, store: await sharedMap.get() } : undefined
    const organization = sharedOrganization && organizationConfig ? { agentId: organizationConfig.agentId, store: await sharedOrganization.get() } : undefined
    const person = sharedCharacters && creator ? await sharedCharacters.get() : undefined
    const characters = person && creator ? { agentId: creator.agentId, store: person.store } : undefined
    const relationships = person && creator ? { agentId: creator.agentId, store: person.relationships } : undefined
    const history = sharedHistory && historyConfig ? { agentId: historyConfig.agentId, store: await sharedHistory.get() } : undefined
    const resolveReference = await createSituationReferenceResolver({ ...situationConfig!.references, ...(map ? { map } : {}), ...(organization ? { organization } : {}), ...(characters ? { characters, relationships } : {}), ...(history ? { history } : {}), workspaces: worlds, worldId: world.worldId })
    return SituationStore.open({ fs, root: owner.writableRoot, worldId: world.worldId, access: 'read-write', phase: 'initialization', singleWriterProcess: true, resolveReference })
  }) : undefined
  if (developmentConfig && specificConfig?.references?.development) throw new Error('共享规划与外部规划引用不能同时配置')
  const sharedDevelopment = developmentConfig ? sharedLocalStore(world.readRoot, async fs => {
    const owner = world.agents.find(item => item.agentId === developmentConfig!.agentId)!
    const map = sharedMap && mapConfig ? { agentId: mapConfig.agentId, store: await sharedMap.get() } : undefined
    const organization = sharedOrganization && organizationConfig ? { agentId: organizationConfig.agentId, store: await sharedOrganization.get() } : undefined
    const person = sharedCharacters && creator ? await sharedCharacters.get() : undefined
    const characters = person && creator ? { agentId: creator.agentId, store: person.store } : undefined
    const relationships = person && creator ? { agentId: creator.agentId, store: person.relationships } : undefined
    const history = sharedHistory && historyConfig ? { agentId: historyConfig.agentId, store: await sharedHistory.get() } : undefined
    const situation = sharedSituation && situationConfig ? { agentId: situationConfig.agentId, store: await sharedSituation.get() } : undefined
    const references = await createWorldDevelopmentResolvers({ ...developmentConfig!.references, ...(map ? { map } : {}), ...(organization ? { organization } : {}), ...(characters ? { characters, relationships } : {}), ...(history ? { history } : {}), ...(situation ? { situation } : {}), workspaces: worlds, worldId: world.worldId })
    return DevelopmentStore.open({ fs, root: owner.writableRoot, worldId: world.worldId, access: 'read-write', phase: 'initialization', singleWriterProcess: true, ...references })
  }) : undefined
  const sharedSpecific = specificConfig ? sharedLocalStore(world.readRoot, async fs => {
    const owner = world.agents.find(item => item.agentId === specificConfig.agentId)
    if (!owner) throw new Error('专有内容负责人不属于该世界')
    const map = sharedMap && mapConfig ? { agentId: mapConfig.agentId, store: await sharedMap.get() } : undefined
    const organization = sharedOrganization && organizationConfig ? { agentId: organizationConfig.agentId, store: await sharedOrganization.get() } : undefined
    const person = sharedCharacters && creator ? await sharedCharacters.get() : undefined
    const characters = person && creator ? { agentId: creator.agentId, store: person.store } : undefined
    const relationships = person && creator ? { agentId: creator.agentId, store: person.relationships } : undefined
    const history = sharedHistory && historyConfig ? { agentId: historyConfig.agentId, store: await sharedHistory.get() } : undefined
    const situation = sharedSituation && situationConfig ? { agentId: situationConfig.agentId, store: await sharedSituation.get() } : undefined
    const development = sharedDevelopment && developmentConfig ? { agentId: developmentConfig.agentId, store: await sharedDevelopment.get() } : undefined
    const resolveReference = await createWorldSpecificResolver({ ...specificConfig.references, ...(map ? { map } : {}), ...(organization ? { organization } : {}), ...(characters ? { characters, relationships } : {}), ...(history ? { history } : {}), ...(situation ? { situation } : {}), ...(development ? { development } : {}), workspaces: worlds, worldId: world.worldId })
    return SpecificStore.open({ fs, root: owner.writableRoot, worldId: world.worldId, access: 'read-write', phase: 'initialization', singleWriterProcess: true, resolveReference })
  }) : undefined
  let closing: Promise<void> | undefined
  return {
    sharedMap, sharedOrganization, sharedCharacters, sharedHistory, sharedSituation, sharedDevelopment, sharedSpecific,
    close: () => closing ??= (async () => {
      await sharedSpecific?.close(); await sharedDevelopment?.close(); await sharedSituation?.close(); await sharedHistory?.close()
      await sharedOrganization?.close(); await sharedCharacters?.close(); await sharedMap?.close()
    })(),
  }
}
