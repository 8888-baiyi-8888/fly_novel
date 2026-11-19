import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { bootstrapAgents, createSpawnAgentCreator, jsonlSessionPersistencePlugin, type Agent } from '@fly-novel/agents'
import { sandboxPolicyPluginDefinition } from '@fly-novel/sandbox-policy'
import { fsSandboxPluginDefinition, isPathUnder } from '@fly-novel/fs-sandbox'
import { createPersistentAgentCreator, createPersistentAgentRouter } from '@fly-novel/subagent-persistent-in-process'
import { fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import { toolFsPluginDefinition, toolFsReadPluginDefinition } from '@fly-novel/tool-fs'
import { toolFsSearchPluginDefinition } from '@fly-novel/tool-fs-search'
import { localSubprocessPluginDefinition } from '@fly-novel/subprocess-local'
import { registerAll } from '@fly-novel/util'
import { defineTool } from '@fly-novel/tools'
import { loadConfiguredAdapter } from '../call-llm.js'
import { createCatalogTools, createCharacterCreatorDelegationTool, createHistoryDelegationTool, createInitialSituationDelegationTool, createWorldDevelopmentDelegationTool, createWorldSpecificDelegationTool, createOrganizationDelegationTool, readFileTool } from '../../tools/index.js'
import { createCharacterCreator, type CharacterCreatorConfig } from './character-creator.js'
import { createWorldBasicsAgentWithCatalogBinding, type WorldBasicsConfig } from './world-basics.js'
import { createWorldBasicsDelegationTool } from '../../tools/subagent-world-basics/delegate-world-basics.js'
import { createMapAgentWithCatalogBinding, type MapAgentConfig } from './map-agent.js'
import { createMapDelegationTool } from '@fly-novel/map'
import { createOrganizationAgentWithCatalogBinding, type OrganizationAgentConfig } from './organization-agent.js'
import { createOrganizationReferenceResolvers } from './organization-references.js'
import { createHistoryAgentWithCatalogBinding, type HistoryAgentConfig } from './history-agent.js'
import { createHistoryReferenceResolvers } from './history-references.js'
import { createInitialSituationAgentWithCatalogBinding, type InitialSituationAgentConfig } from './initial-situation-agent.js'
import { createSituationReferenceResolver } from './initial-situation-references.js'
import { createWorldDevelopmentAgentWithCatalogBinding, type WorldDevelopmentAgentConfig } from './world-development-agent.js'
import { createWorldDevelopmentResolvers } from './world-development-references.js'
import { createWorldSpecificAgentWithCatalogBinding, type WorldSpecificAgentConfig } from './world-specific-agent.js'
import { createWorldSpecificResolver } from './world-specific-references.js'
import { validateWorldInitializationWorkspace, type WorldInitializationWorkspace } from './world-initialization-workspace.js'
import { worldInitializationDraftFsPluginDefinition } from './world-initialization-draft-fs.js'
import { worldInitializationSkillPluginDefinition } from './world-initialization-skill.js'
import { worldInitializationWorkspacePromptPluginDefinition } from './world-initialization-workspace-prompt.js'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../../world-init/workspace/config.js'
import { acquireWorldAgentLease } from '../../world-init/workspace/agent-lease.js'
import { CatalogService, type CatalogBinding } from '../../world-init/workspace/catalog/service.js'
import { SharedMapStorage } from '../../world-init/storage/map.js'
import { SharedOrganizationStorage } from '../../world-init/storage/organization.js'
import { SharedCharacterStorage } from '../../world-init/storage/character.js'
import { sharedLocalStore } from '../../world-init/storage/local.js'
import { HistoryStore } from '@fly-novel/history'
import { SituationStore } from '@fly-novel/initial-situation'

/** 此 Agent 除插件自动注册的工具外，还需要的具体工具。 */
const worldInitializationTools = [readFileTool] as const

/** 角色创建 Agent 的非授权配置；世界和目录由工作区绑定。 */
export type WorkspaceCharacterCreatorConfig = Omit<CharacterCreatorConfig, 'worldId' | 'readRoot' | 'characterRoot' | 'createCatalogBinding' | 'workspaces'>

/** 基础信息 Agent 的非授权配置；世界和目录由工作区绑定。 */
export type WorkspaceWorldBasicsConfig = Omit<WorldBasicsConfig, 'workspaces' | 'worldId' | 'singleWriterProcess' | 'catalog'>
/** 地图 Agent 的非授权配置；世界和目录由工作区绑定。 */
export type WorkspaceMapAgentConfig = Omit<MapAgentConfig, 'workspaces' | 'worldId' | 'singleWriterProcess' | 'catalog'>
/** 组织 Agent 的非授权配置；世界和目录由工作区绑定。 */
export type WorkspaceOrganizationAgentConfig = Omit<OrganizationAgentConfig, 'workspaces' | 'worldId' | 'singleWriterProcess' | 'catalog'>
export type WorkspaceHistoryAgentConfig = Omit<HistoryAgentConfig, 'workspaces' | 'worldId' | 'singleWriterProcess' | 'catalog'>
export type WorkspaceInitialSituationAgentConfig = Omit<InitialSituationAgentConfig, 'workspaces' | 'worldId' | 'singleWriterProcess' | 'catalog'>
export type WorkspaceWorldDevelopmentAgentConfig = Omit<WorldDevelopmentAgentConfig, 'workspaces' | 'worldId' | 'singleWriterProcess' | 'catalog'>
export type WorkspaceWorldSpecificAgentConfig = Omit<WorldSpecificAgentConfig, 'workspaces' | 'worldId' | 'singleWriterProcess' | 'catalog'>

/** 由可信应用指定主 Agent 会话；目录必须存在且不与世界读取范围重叠。 */
export interface WorldInitializationSessionConfig {
  readonly sessionRoot: string
  readonly sessionId: string
  readonly sessionMode: 'create' | 'resume'
}

/**
 * 从可信世界配置创建主 Agent 并按稳定身份绑定角色 Agent。
 * @param workspaces 本次应用装配范围内的全部世界配置。
 * @param worldId 由可信应用选定的世界身份。
 * @param characterCreator 可选的角色 Agent 模型与 Session 配置。
 * @param deployment 单进程写入保证及可选的目录、主 Agent Session 配置；恢复时须提供相同世界、身份和 Session ID。
 * @returns 已装配的主 Agent；调用方须等待 dispose。
 */
export async function createWorldInitializationAgentWithWorldWorkspaces(
  workspaces: readonly WorldWorkspaceConfig[], worldId: string, characterCreator: WorkspaceCharacterCreatorConfig | undefined,
  deployment: { readonly singleWriterProcess: true; readonly catalog?: { readonly maxCatalogBytes?: number; readonly maxSourceBytes?: number; readonly receiptTtlMs?: number; readonly maxReceipts?: number }; readonly mainSession?: WorldInitializationSessionConfig; readonly worldBasics?: WorkspaceWorldBasicsConfig; readonly mapAgent?: WorkspaceMapAgentConfig; readonly organizationAgent?: WorkspaceOrganizationAgentConfig; readonly historyAgent?: WorkspaceHistoryAgentConfig; readonly initialSituationAgent?: WorkspaceInitialSituationAgentConfig; readonly worldDevelopmentAgent?: WorkspaceWorldDevelopmentAgentConfig; readonly worldSpecificAgent?: WorkspaceWorldSpecificAgentConfig },
): Promise<Agent> {
  if (deployment?.singleWriterProcess !== true) throw new Error('必须确保同一世界仅由一个可信应用进程写入')
  const worlds = await validateWorldWorkspaceConfigs(workspaces)
  const world = worlds.find(item => item.worldId === worldId)
  if (!world) throw new Error('世界配置不存在')
  let mainSession: { root: string; id: string; mode: 'create' | 'resume' } | undefined
  if (deployment.mainSession) {
    const { sessionRoot, sessionId, sessionMode } = deployment.mainSession
    if (typeof sessionId !== 'string' || !sessionId || sessionId.trim() !== sessionId || (sessionMode !== 'create' && sessionMode !== 'resume') ||
        typeof sessionRoot !== 'string' || !isAbsolute(sessionRoot)) throw new Error('主 Agent Session 配置无效')
    const root = await realpath(sessionRoot)
    if (root !== resolve(sessionRoot) || !(await stat(root)).isDirectory()) throw new Error('主 Agent Session 目录必须是现有真实目录')
    for (const item of worlds) {
      if (await isPathUnder(root, item.readRoot) || await isPathUnder(item.readRoot, root)) throw new Error('主 Agent Session 目录不能与任何世界读取根重叠')
    }
    const id = `world-initialization-${createHash('sha256').update(JSON.stringify([world.worldId, world.mainAgent.agentId, sessionId])).digest('hex')}`
    mainSession = { root, id, mode: sessionMode }
  }
  let creator: CharacterCreatorConfig | undefined
  if (characterCreator) {
    const owner = world.agents.find(item => item.agentId === characterCreator.agentId)
    if (!owner) throw new Error('角色创建 Agent 身份不属于该世界的特殊 Agent')
    const sessionRoot = await realpath(characterCreator.sessionRoot)
    for (const item of worlds) {
      if (await isPathUnder(sessionRoot, item.readRoot) || await isPathUnder(item.readRoot, sessionRoot)) {
        throw new Error('角色 Session 目录不能与任何世界读取根重叠')
      }
    }
    creator = { ...characterCreator, worldId: world.worldId, readRoot: world.readRoot, characterRoot: owner.writableRoot, workspaces: worlds, createCatalogBinding: undefined }
  }
  let basics: WorldBasicsConfig | undefined
  if (deployment.worldBasics) {
    const config = deployment.worldBasics
    if (!world.agents.some(item => item.agentId === config.agentId)) throw new Error('世界基础信息 Agent 身份不属于该世界的特殊 Agent')
    if (creator?.agentId === config.agentId) throw new Error('角色创建与世界基础信息 Agent 身份不能相同')
    const sessionRoot = await realpath(config.sessionRoot)
    for (const item of worlds) {
      if (await isPathUnder(sessionRoot, item.readRoot) || await isPathUnder(item.readRoot, sessionRoot)) throw new Error('基础信息 Session 目录不能与任何世界读取根重叠')
    }
    basics = { ...config, workspaces: worlds, worldId: world.worldId, singleWriterProcess: true }
  }
  let mapConfig: MapAgentConfig | undefined
  if (deployment.mapAgent) {
    const config = deployment.mapAgent
    const owner = world.agents.find(item => item.agentId === config.agentId)
    if (!owner) throw new Error('地图 Agent 身份不属于该世界的特殊 Agent')
    if (creator?.agentId === config.agentId || basics?.agentId === config.agentId) throw new Error('地图 Agent 与其他专用 Agent 身份不能相同')
    for (const name of ['places', 'connections']) {
      const path = resolve(owner.writableRoot, name)
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('地图子目录必须是现有真实目录')
    }
    const sessionRoot = await realpath(config.sessionRoot)
    for (const item of worlds) if (await isPathUnder(sessionRoot, item.readRoot) || await isPathUnder(item.readRoot, sessionRoot)) throw new Error('地图 Session 目录不能与任何世界读取根重叠')
    mapConfig = { ...config, workspaces: worlds, worldId: world.worldId, singleWriterProcess: true }
  }
  let organizationConfig: OrganizationAgentConfig | undefined
  if (deployment.organizationAgent) {
    const config = deployment.organizationAgent
    const owner = world.agents.find(item => item.agentId === config.agentId)
    if (!owner) throw new Error('组织 Agent 身份不属于该世界的特殊 Agent')
    if ([creator?.agentId, basics?.agentId, mapConfig?.agentId].includes(config.agentId)) throw new Error('组织 Agent 与其他专用 Agent 身份不能相同')
    for (const name of ['organizations', 'relations', 'memberships']) {
      const path = resolve(owner.writableRoot, name)
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('组织子目录必须是现有真实目录')
    }
    const sessionRoot = await realpath(config.sessionRoot)
    for (const item of worlds) if (await isPathUnder(sessionRoot, item.readRoot) || await isPathUnder(item.readRoot, sessionRoot)) throw new Error('组织 Session 目录不能与任何世界读取根重叠')
    if (config.references) await createOrganizationReferenceResolvers({ ...config.references, workspaces: worlds, worldId: world.worldId })
    organizationConfig = { ...config, workspaces: worlds, worldId: world.worldId, singleWriterProcess: true }
  }
  let historyConfig: HistoryAgentConfig | undefined
  if (deployment.historyAgent) {
    const config = deployment.historyAgent; const owner = world.agents.find(item => item.agentId === config.agentId)
    if (!owner) throw new Error('历史 Agent 身份不属于该世界的特殊 Agent')
    if ([creator?.agentId, basics?.agentId, mapConfig?.agentId, organizationConfig?.agentId].includes(config.agentId)) throw new Error('历史 Agent 与其他专用 Agent 身份不能相同')
    for (const name of ['events', 'candidates']) {
      const path = resolve(owner.writableRoot, name)
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('历史子目录必须是现有真实目录')
    }
    const sessionRoot = await realpath(config.sessionRoot)
    for (const item of worlds) if (await isPathUnder(sessionRoot, item.readRoot) || await isPathUnder(item.readRoot, sessionRoot)) throw new Error('历史 Session 目录不能与任何世界读取根重叠')
    if (config.references) await createHistoryReferenceResolvers({ ...config.references, workspaces: worlds, worldId: world.worldId })
    historyConfig = { ...config, workspaces: worlds, worldId: world.worldId, singleWriterProcess: true }
  }
  let situationConfig: InitialSituationAgentConfig | undefined
  if (deployment.initialSituationAgent) {
    const config = deployment.initialSituationAgent; const owner = world.agents.find(item => item.agentId === config.agentId)
    if (!owner) throw new Error('初始局势 Agent 身份不属于该世界的特殊 Agent')
    if ([creator?.agentId, basics?.agentId, mapConfig?.agentId, organizationConfig?.agentId, historyConfig?.agentId].includes(config.agentId)) throw new Error('初始局势 Agent 与其他专用 Agent 身份不能相同')
    for (const name of ['overviews', 'situations', 'candidates']) {
      const path = resolve(owner.writableRoot, name)
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('初始局势子目录必须是现有真实目录')
    }
    const sessionRoot = await realpath(config.sessionRoot)
    for (const item of worlds) if (await isPathUnder(sessionRoot, item.readRoot) || await isPathUnder(item.readRoot, sessionRoot)) throw new Error('初始局势 Session 目录不能与任何世界读取根重叠')
    if (config.references) await createSituationReferenceResolver({ ...config.references, workspaces: worlds, worldId: world.worldId })
    situationConfig = { ...config, workspaces: worlds, worldId: world.worldId, singleWriterProcess: true }
  }
  let developmentConfig: WorldDevelopmentAgentConfig | undefined
  if (deployment.worldDevelopmentAgent) {
    const config = deployment.worldDevelopmentAgent; const owner = world.agents.find(item => item.agentId === config.agentId)
    if (!owner) throw new Error('世界发展规划 Agent 身份不属于该世界的特殊 Agent')
    if ([creator?.agentId, basics?.agentId, mapConfig?.agentId, organizationConfig?.agentId, historyConfig?.agentId, situationConfig?.agentId].includes(config.agentId)) throw new Error('世界发展规划 Agent 与其他专用 Agent 身份不能相同')
    for (const name of ['macro-development/blueprints', 'macro-development/directions', 'macro-development/proposals', 'storylines/stories', 'storylines/growth-lines', 'character-growth/blueprints', 'character-growth/items', 'candidates']) {
      const path = resolve(owner.writableRoot, name)
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('世界发展规划子目录必须是现有真实目录')
    }
    const sessionRoot = await realpath(config.sessionRoot)
    for (const item of worlds) if (await isPathUnder(sessionRoot, item.readRoot) || await isPathUnder(item.readRoot, sessionRoot)) throw new Error('世界发展规划 Session 目录不能与任何世界读取根重叠')
    if (config.references) await createWorldDevelopmentResolvers({ ...config.references, workspaces: worlds, worldId: world.worldId })
    developmentConfig = { ...config, workspaces: worlds, worldId: world.worldId, singleWriterProcess: true }
  }
  let specificConfig: WorldSpecificAgentConfig | undefined
  if (deployment.worldSpecificAgent) {
    const config = deployment.worldSpecificAgent; const owner = world.agents.find(item => item.agentId === config.agentId)
    if (!owner) throw new Error('世界专有内容 Agent 身份不属于该世界的特殊 Agent')
    if ([creator?.agentId, basics?.agentId, mapConfig?.agentId, organizationConfig?.agentId, historyConfig?.agentId, situationConfig?.agentId, developmentConfig?.agentId].includes(config.agentId)) throw new Error('世界专有内容 Agent 与其他专用 Agent 身份不能相同')
    for (const name of ['topics', 'items', 'candidates']) {
      const path = resolve(owner.writableRoot, name)
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('世界专有内容子目录必须是现有真实目录')
    }
    const sessionRoot = await realpath(config.sessionRoot)
    for (const item of worlds) if (await isPathUnder(sessionRoot, item.readRoot) || await isPathUnder(item.readRoot, sessionRoot)) throw new Error('世界专有内容 Session 目录不能与任何世界读取根重叠')
    if (config.references) await createWorldSpecificResolver({ ...config.references, workspaces: worlds, worldId: world.worldId })
    specificConfig = { ...config, workspaces: worlds, worldId: world.worldId, singleWriterProcess: true }
  }
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
  const releaseIdentity = acquireWorldAgentLease(world.worldId, world.mainAgent.agentId)
  let agent: Agent
  let catalog: CatalogService | undefined
  let mainBinding: CatalogBinding | undefined
  try {
    if (deployment.catalog) catalog = await CatalogService.open(world, { singleWriterProcess: true, ...deployment.catalog })
    if (creator && catalog) {
      const service = catalog; const agentId = creator.agentId
      creator = { ...creator, createCatalogBinding: () => service.bind(agentId) }
    }
    mainBinding = catalog?.bind(world.mainAgent.agentId)
    agent = await createWorldInitializationAgentWithWorkspaceInternal({ viewRoot: world.readRoot, draftRoot: world.mainAgent.writableRoot,
      confirmedRoot: world.confirmedRoot }, creator, mainBinding, mainBinding ? world.mainAgent.agentId : undefined, mainSession,
      basics, catalog && basics ? () => catalog!.bind(basics!.agentId) : undefined,
      mapConfig, catalog && mapConfig ? () => catalog!.bind(mapConfig!.agentId) : undefined,
      organizationConfig, catalog && organizationConfig ? () => catalog!.bind(organizationConfig!.agentId) : undefined,
      historyConfig, catalog && historyConfig ? () => catalog!.bind(historyConfig!.agentId) : undefined,
      situationConfig, catalog && situationConfig ? () => catalog!.bind(situationConfig!.agentId) : undefined,
      developmentConfig, catalog && developmentConfig ? () => catalog!.bind(developmentConfig!.agentId) : undefined,
      specificConfig, catalog && specificConfig ? () => catalog!.bind(specificConfig!.agentId) : undefined, sharedMap, sharedOrganization, sharedCharacters, sharedHistory, sharedSituation)
  } catch (error) {
    if (!(error instanceof AggregateError)) {
      try { await sharedSituation?.close(); await sharedHistory?.close(); await sharedOrganization?.close(); await sharedCharacters?.close(); await sharedMap?.close(); await mainBinding?.close(); await catalog?.close(); releaseIdentity() } catch (cleanup) { throw new AggregateError([error, cleanup], '工作区装配和目录服务清理失败') }
    }
    throw error
  }
  let disposal: Promise<void> | undefined
  return {
    info: agent.info, context: agent.context,
    get state() { return agent.state },
    run: input => agent.run(input), cancel: () => agent.cancel(),
    dispose: () => disposal ??= (async () => { await agent.dispose(); await sharedSituation?.close(); await sharedHistory?.close(); await sharedOrganization?.close(); await sharedCharacters?.close(); await sharedMap?.close(); await mainBinding?.close(); await catalog?.close(); releaseIdentity() })(),
  }
}

/**
 * 使用本机 DeepSeek 配置和仓库 Skill 目录创建世界初始化主 Agent。
 * @returns 初始化完成的 Agent；调用方使用完毕后须调用其 dispose()。
 * @throws 模型配置、Skill 目录或 Agent 初始化失败时拒绝创建。
 */
export async function createWorldInitializationAgent(): Promise<Agent> {
  const workingDirectory = process.cwd()
  const skillRoot = resolve(workingDirectory, 'src/agents/world-initialization-main-agent/skills')
  if (!(await stat(skillRoot)).isDirectory()) throw new Error('世界初始化 Skill 根路径不是目录')
  const { provider, model, adapter } = await loadConfiguredAdapter('deepseek')
  const { factory } = await bootstrapAgents()
  const agent = await factory.create({
    id: `world-initialization-${randomUUID()}`,
    presetId: 'world-initialization-main-agent',
    pluginConfigs: {
      'agent-loop-runtime': { provider, model, workingDirectory },
      llm: { adapters: [{ providers: [provider], adapter }] },
      'skill-filesystem': { root: skillRoot },
    },
  })
  registerAll(worldInitializationTools, tool => {
    try {
      agent.context.tools.register(tool)
    } catch (error) {
      console.error(`工具 "${tool.name}" 注册失败：`, error)
    }
  })
  return agent
}

/**
 * 使用可信工作区创建带文件工具及只读子 Agent 的世界初始化主 Agent。
 * @param workspace 已有的读取视图、草稿目录和已确认资料目录。
 * @param characterCreator 可选的可信角色创建 Agent 配置；不由模型提供。
 * @returns 初始化完成的 Agent；调用方使用完毕后须调用 dispose()。
 */
export async function createWorldInitializationAgentWithWorkspace(workspace: WorldInitializationWorkspace, characterCreator?: CharacterCreatorConfig): Promise<Agent> {
  return createWorldInitializationAgentWithWorkspaceInternal(workspace, characterCreator)
}

async function createWorldInitializationAgentWithWorkspaceInternal(workspace: WorldInitializationWorkspace, characterCreator?: CharacterCreatorConfig,
  catalogBinding?: CatalogBinding, catalogMainOwner?: string, mainSession?: { root: string; id: string; mode: 'create' | 'resume' },
  basicsConfig?: WorldBasicsConfig, createBasicsCatalogBinding?: () => CatalogBinding,
  mapConfig?: MapAgentConfig, createMapCatalogBinding?: () => CatalogBinding,
  organizationConfig?: OrganizationAgentConfig, createOrganizationCatalogBinding?: () => CatalogBinding,
  historyConfig?: HistoryAgentConfig, createHistoryCatalogBinding?: () => CatalogBinding,
  situationConfig?: InitialSituationAgentConfig, createSituationCatalogBinding?: () => CatalogBinding,
  developmentConfig?: WorldDevelopmentAgentConfig, createDevelopmentCatalogBinding?: () => CatalogBinding,
  specificConfig?: WorldSpecificAgentConfig, createSpecificCatalogBinding?: () => CatalogBinding, sharedMap?: SharedMapStorage, sharedOrganization?: SharedOrganizationStorage, sharedCharacters?: SharedCharacterStorage, sharedHistory?: import('../../world-init/storage/resource.js').SharedResource<HistoryStore>, sharedSituation?: import('../../world-init/storage/resource.js').SharedResource<SituationStore>): Promise<Agent> {
  const roots = await validateWorldInitializationWorkspace(workspace)
  const creatorConfig = characterCreator && { ...characterCreator }
  if (creatorConfig) {
    const [readRoot, characterRoot, sessionRoot] = await Promise.all([
      realpath(creatorConfig.readRoot), realpath(creatorConfig.characterRoot), realpath(creatorConfig.sessionRoot),
    ])
    if (readRoot !== roots.viewRoot || readRoot !== resolve(creatorConfig.readRoot) || characterRoot !== resolve(creatorConfig.characterRoot) || sessionRoot !== resolve(creatorConfig.sessionRoot)) {
      throw new Error('角色创建 Agent 的读取视图及目录必须使用可信真实路径')
    }
    if (!await isPathUnder(characterRoot, roots.viewRoot) || characterRoot === roots.viewRoot ||
        await isPathUnder(characterRoot, roots.draftRoot) || await isPathUnder(roots.draftRoot, characterRoot) ||
        await isPathUnder(characterRoot, roots.confirmedRoot) || await isPathUnder(roots.confirmedRoot, characterRoot)) {
      throw new Error('角色目录必须位于读取视图内，且不能与草稿或已确认资料根重叠')
    }
    if (await isPathUnder(sessionRoot, roots.viewRoot) || await isPathUnder(roots.viewRoot, sessionRoot)) throw new Error('角色 Session 目录不能与读取视图重叠')
  }
  const skillRoot = resolve(process.cwd(), 'src/agents/world-initialization-main-agent/skills')
  if (!(await stat(skillRoot)).isDirectory()) throw new Error('世界初始化 Skill 根路径不是目录')
  const { provider, model, adapter } = await loadConfiguredAdapter('deepseek')
  const framework = await bootstrapAgents()
  for (const definition of [sandboxPolicyPluginDefinition, fsSandboxPluginDefinition, fsObservationPolicyPluginDefinition,
    toolFsPluginDefinition, toolFsReadPluginDefinition, toolFsSearchPluginDefinition, localSubprocessPluginDefinition,
    worldInitializationDraftFsPluginDefinition, worldInitializationSkillPluginDefinition, worldInitializationWorkspacePromptPluginDefinition]) framework.plugins.register(definition)
  const fileChildId = 'world-initialization-readonly-subagent'
  const baseChild = framework.presets.get('generic-subagent')
  framework.presets.register({ ...baseChild, id: fileChildId, plugins: [...baseChild.plugins,
    { pluginId: 'tools' }, { pluginId: 'world-initialization-workspace-prompt' }, { pluginId: 'sandbox-policy' }, { pluginId: 'fs-sandbox' },
    { pluginId: 'fs-observation-policy' }, { pluginId: 'subprocess-local' }, { pluginId: 'tool-fs-read' }, { pluginId: 'tool-fs-search' },
  ] })
  const baseMain = framework.presets.get('world-initialization-main-agent')
  const mainId = 'world-initialization-file-main'
  framework.presets.register({ ...baseMain, id: mainId, plugins: [...baseMain.plugins.filter(binding => binding.pluginId !== 'skill-filesystem'),
    { pluginId: 'world-initialization-skill-source' }, { pluginId: 'world-initialization-workspace-prompt' },
    { pluginId: 'sandbox-policy' }, { pluginId: 'world-initialization-draft-fs' }, { pluginId: 'fs-observation-policy' },
    { pluginId: 'subprocess-local' }, { pluginId: 'tool-fs' }, { pluginId: 'tool-fs-search' },
    { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' }, { pluginId: 'tool-subagent' },
    ...(creatorConfig || basicsConfig || mapConfig || organizationConfig || historyConfig || situationConfig || developmentConfig || specificConfig ? [{ pluginId: 'subagent-persistent-in-process' }] : []),
  ] })
  const modelConfig = { adapters: [{ providers: [provider], adapter }] }
  const loopConfig = { provider, model, workingDirectory: roots.viewRoot }
  const create = createSpawnAgentCreator(framework, { [fileChildId]: {
    'agent-loop-runtime': loopConfig, llm: modelConfig,
    'sandbox-policy': { mode: 'read-only', workspaceRoot: roots.viewRoot }, 'fs-sandbox': { cwd: roots.viewRoot },
    'world-initialization-workspace-prompt': { ...roots, mode: 'read-only' },
  } })
  const characterCreate = creatorConfig && createPersistentAgentCreator({ presetId: 'character-creator', sessionMode: creatorConfig.sessionMode,
    async create({ sessionMode, initial }) {
      const map = sharedMap && mapConfig ? { agentId: mapConfig.agentId, store: await sharedMap.get() } : undefined
      const organization = sharedOrganization && organizationConfig ? { agentId: organizationConfig.agentId, store: await sharedOrganization.get() } : undefined
      const child = await createCharacterCreator({ ...creatorConfig, ...(map || organization ? { references: { ...creatorConfig.references, ...(map ? { map } : {}), ...(organization ? { organization } : {}) } } : {}), sessionMode, initializeCharacters: initial && creatorConfig.initializeCharacters }, await sharedCharacters?.get())
      return { agent: child, dispose: () => child.dispose() }
    } })
  const basicsCreate = basicsConfig && createPersistentAgentCreator({ presetId: 'world-basics', sessionMode: basicsConfig.sessionMode,
    async create({ sessionMode }) {
      const child = await createWorldBasicsAgentWithCatalogBinding({ ...basicsConfig, sessionMode }, createBasicsCatalogBinding)
      return { agent: child, dispose: () => child.dispose() }
    } })
  const mapCreate = mapConfig && createPersistentAgentCreator({ presetId: 'map-agent', sessionMode: mapConfig.sessionMode,
    async create({ sessionMode }) {
      const child = await createMapAgentWithCatalogBinding({ ...mapConfig, sessionMode }, createMapCatalogBinding, await sharedMap?.get())
      return { agent: child, dispose: () => child.dispose() }
    } })
  const organizationCreate = organizationConfig && createPersistentAgentCreator({ presetId: 'organization-agent', sessionMode: organizationConfig.sessionMode,
    async create({ sessionMode }) {
      const map = sharedMap && mapConfig ? { agentId: mapConfig.agentId, store: await sharedMap.get() } : undefined
      const child = await createOrganizationAgentWithCatalogBinding({ ...organizationConfig, ...(map ? { references: { ...organizationConfig.references, map } } : {}), sessionMode }, createOrganizationCatalogBinding, await sharedOrganization?.get())
      return { agent: child, dispose: () => child.dispose() }
    } })
  const sharedReferences = async () => ({
    ...(sharedMap && mapConfig ? { map: { agentId: mapConfig.agentId, store: await sharedMap.get() } } : {}),
    ...(sharedOrganization && organizationConfig ? { organization: { agentId: organizationConfig.agentId, store: await sharedOrganization.get() } } : {}),
    ...(sharedCharacters && creatorConfig ? { characters: { agentId: creatorConfig.agentId, store: (await sharedCharacters.get()).store }, relationships: { agentId: creatorConfig.agentId, store: (await sharedCharacters.get()).relationships } } : {}),
  })
  const historyCreate = historyConfig && createPersistentAgentCreator({ presetId: 'history-agent', sessionMode: historyConfig.sessionMode,
    async create({ sessionMode }) { const child = await createHistoryAgentWithCatalogBinding({ ...historyConfig, references: { ...historyConfig.references, ...await sharedReferences() }, sessionMode }, createHistoryCatalogBinding, await sharedHistory?.get()); return { agent: child, dispose: () => child.dispose() } } })
  const historyReference = async () => sharedHistory && historyConfig ? { history: { agentId: historyConfig.agentId, store: await sharedHistory.get() } } : {}
  const situationCreate = situationConfig && createPersistentAgentCreator({ presetId: 'initial-situation-agent', sessionMode: situationConfig.sessionMode,
    async create({ sessionMode }) { const child = await createInitialSituationAgentWithCatalogBinding({ ...situationConfig, references: { ...situationConfig.references, ...await sharedReferences(), ...await historyReference() }, sessionMode }, createSituationCatalogBinding, await sharedSituation?.get()); return { agent: child, dispose: () => child.dispose() } } })
  const situationReference = async () => sharedSituation && situationConfig ? { situation: { agentId: situationConfig.agentId, store: await sharedSituation.get() } } : {}
  const developmentCreate = developmentConfig && createPersistentAgentCreator({ presetId: 'world-development-agent', sessionMode: developmentConfig.sessionMode,
    async create({ sessionMode }) { const child = await createWorldDevelopmentAgentWithCatalogBinding({ ...developmentConfig, references: { ...developmentConfig.references, ...await sharedReferences(), ...await historyReference(), ...await situationReference() }, sessionMode }, createDevelopmentCatalogBinding); return { agent: child, dispose: () => child.dispose() } } })
  const specificCreate = specificConfig && createPersistentAgentCreator({ presetId: 'world-specific-agent', sessionMode: specificConfig.sessionMode,
    async create({ sessionMode }) { const child = await createWorldSpecificAgentWithCatalogBinding({ ...specificConfig, references: { ...specificConfig.references, ...await sharedReferences(), ...await historyReference(), ...await situationReference() }, sessionMode }, createSpecificCatalogBinding); return { agent: child, dispose: () => child.dispose() } } })
  const routes = { ...(characterCreate ? { 'character-creator': characterCreate } : {}), ...(basicsCreate ? { 'world-basics': basicsCreate } : {}), ...(mapCreate ? { 'map-agent': mapCreate } : {}), ...(organizationCreate ? { 'organization-agent': organizationCreate } : {}), ...(historyCreate ? { 'history-agent': historyCreate } : {}), ...(situationCreate ? { 'initial-situation-agent': situationCreate } : {}), ...(developmentCreate ? { 'world-development-agent': developmentCreate } : {}), ...(specificCreate ? { 'world-specific-agent': specificCreate } : {}) }
  const persistentCreate = characterCreate || basicsCreate || mapCreate || organizationCreate || historyCreate || situationCreate || developmentCreate || specificCreate ? createPersistentAgentRouter(routes) : undefined
  let backend: ReturnType<typeof framework.context.plugin> | undefined
  let agent: Agent | undefined
  try {
    if (mainSession) {
      backend = framework.context.plugin(jsonlSessionPersistencePlugin, { root: mainSession.root })
      await backend
    }
    agent = await framework.factory.create({ id: `world-initialization-${randomUUID()}`, presetId: mainId, pluginConfigs: {
    'agent-loop-runtime': { ...loopConfig, ...(mainSession && (mainSession.mode === 'create' ? { sessionId: mainSession.id } : { resumeSessionId: mainSession.id })) }, llm: modelConfig, 'world-initialization-skill-source': { root: skillRoot },
    'sandbox-policy': { mode: 'workspace-write', workspaceRoot: roots.draftRoot },
    'world-initialization-draft-fs': { cwd: roots.viewRoot, draftRoot: roots.draftRoot },
    'world-initialization-workspace-prompt': { ...roots, mode: 'draft-write', worldBasics: Boolean(basicsConfig), mapAgent: Boolean(mapConfig), organizationAgent: Boolean(organizationConfig), historyAgent: Boolean(historyConfig), initialSituationAgent: Boolean(situationConfig), worldDevelopmentAgent: Boolean(developmentConfig), worldSpecificAgent: Boolean(specificConfig), ...(catalogBinding && catalogMainOwner ? { catalog: {
      mainOwner: catalogMainOwner, delegates: [...(creatorConfig ? [{ owner: creatorConfig.agentId, tool: 'delegate_character_creator' }] : []),
        ...(basicsConfig ? [{ owner: basicsConfig.agentId, tool: 'delegate_world_basics' }] : []), ...(mapConfig ? [{ owner: mapConfig.agentId, tool: 'delegate_map' }] : []), ...(organizationConfig ? [{ owner: organizationConfig.agentId, tool: 'delegate_organization' }] : []), ...(historyConfig ? [{ owner: historyConfig.agentId, tool: 'delegate_history' }] : []), ...(situationConfig ? [{ owner: situationConfig.agentId, tool: 'delegate_initial_situation' }] : []), ...(developmentConfig ? [{ owner: developmentConfig.agentId, tool: 'delegate_world_development' }] : []), ...(specificConfig ? [{ owner: specificConfig.agentId, tool: 'delegate_world_specific' }] : [])],
    } } : {}) },
    'tool-fs': { applyPatch: true }, 'subagent-spawn-in-process': { create }, 'tool-subagent': { presetId: fileChildId },
    ...(persistentCreate ? { 'subagent-persistent-in-process': { create: persistentCreate } } : {}),
    } })
    if (creatorConfig) agent.context.tools.register(createCharacterCreatorDelegationTool(agent.context.subagents, agent.info.identity.id))
    if (basicsConfig) agent.context.tools.register(createWorldBasicsDelegationTool(agent.context.subagents, agent.info.identity.id))
    if (mapConfig) agent.context.tools.register(createMapDelegationTool(agent.context.subagents, agent.info.identity.id))
    if (organizationConfig) agent.context.tools.register(createOrganizationDelegationTool(agent.context.subagents, agent.info.identity.id))
    if (historyConfig) agent.context.tools.register(createHistoryDelegationTool(agent.context.subagents, agent.info.identity.id))
    if (situationConfig) agent.context.tools.register(createInitialSituationDelegationTool(agent.context.subagents, agent.info.identity.id))
    if (developmentConfig) agent.context.tools.register(createWorldDevelopmentDelegationTool(agent.context.subagents, agent.info.identity.id))
    if (specificConfig) agent.context.tools.register(createWorldSpecificDelegationTool(agent.context.subagents, agent.info.identity.id))
    const createdAgent = agent
    const draftRelative = relative(roots.viewRoot, roots.draftRoot).split(sep).join('/')
    agent.context.tools.register(defineTool({
      name: 'save_first_world_plan', description: '保存完整的待审第一版世界方案；每次创建独立文件，不覆盖已有成果。', reportOnAbort: true,
      parameters: { content: { type: 'string', required: true, description: '已经整合的完整第一版方案正文。' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', enum: ['saved', 'unknown'], required: true }, path: { type: 'string', required: true }, reason: { type: 'string' },
      } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute({ content }, exec) {
        if (!content.trim()) throw new Error('世界方案正文不能为空')
        exec.signal.throwIfAborted()
        const path = `${draftRelative}/world-plan-${randomUUID()}.md`
        const target = await createdAgent.context.fs.resolve(path, { cwd: roots.viewRoot, signal: exec.signal })
        try {
          const outcome = await createdAgent.context.fs.writeText(target, `# 第一版世界方案（待审）\n\n${content.trim()}\n`, { kind: 'createIfAbsent' }, exec.signal)
          createdAgent.context.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
          return { status: 'saved' as const, path }
        } catch (error) {
          return { status: 'unknown' as const, path, reason: error instanceof Error ? error.message : String(error) }
        }
      },
    }))
    if (catalogBinding) {
      const identity = agent.context.tools.agent
      if (!identity) throw new Error('主 Agent 的目录工具缺少身份')
      for (const tool of createCatalogTools(catalogBinding, identity)) agent.context.tools.register(tool)
    }
    const created = agent
    const persistence = backend
    let disposal: Promise<void> | undefined
    return { info: created.info, context: created.context, get state() { return created.state },
      run: input => created.run(input), cancel: () => created.cancel(),
      dispose: () => disposal ??= (async () => { await created.dispose(); await persistence?.dispose() })() }
  } catch (error) {
    try { await agent?.dispose(); await backend?.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], '主 Agent 装配和清理失败') }
    throw error
  }
}
