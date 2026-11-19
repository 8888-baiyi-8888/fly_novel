import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { bootstrapAgents, jsonlSessionPersistencePlugin, type Agent } from '@fly-novel/agents'
import type { AgentLoopInput, AgentLoopResult } from '@fly-novel/agent-loop'
import { isPathUnder } from '@fly-novel/fs-sandbox'
import { sandboxPolicyPluginDefinition } from '@fly-novel/sandbox-policy'
import { fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import { toolFsReadPluginDefinition } from '@fly-novel/tool-fs'
import { toolFsSearchPluginDefinition } from '@fly-novel/tool-fs-search'
import { localSubprocessPluginDefinition } from '@fly-novel/subprocess-local'
import { DevelopmentStore, developmentToolsPluginDefinition } from '@fly-novel/world-development'
import { createSituationTools } from '@fly-novel/initial-situation'
import { createHistoryTools } from '@fly-novel/history'
import { createMapTools } from '@fly-novel/map'
import { createOrganizationTools } from '@fly-novel/organization'
import { createCharacterReadTools, createCharacterRelationshipReadTools } from '@fly-novel/character'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import type { LlmAdapter } from '@fly-novel/llm'
import { createCatalogTools, readFileTool } from '../../tools/index.js'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../../world-init/workspace/config.js'
import { acquireWorldAgentLease } from '../../world-init/workspace/agent-lease.js'
import { CatalogService, type CatalogBinding } from '../../world-init/workspace/catalog/service.js'
import { worldInitializationDraftFsPluginDefinition } from './world-initialization-draft-fs.js'
import { createWorldDevelopmentResolvers } from '../../world-init/storage/world-development-references.js'

/** 世界发展规划目录、世界、引用和权限均由可信应用绑定。 */
export interface WorldDevelopmentAgentConfig {
  workspaces: readonly WorldWorkspaceConfig[]; worldId: string; agentId: string; sessionId: string; sessionMode: 'create' | 'resume'
  sessionRoot: string; provider: string; model: string; adapter: LlmAdapter; singleWriterProcess: true
  references?: Pick<Parameters<typeof createWorldDevelopmentResolvers>[0], 'map' | 'characters' | 'organization' | 'history' | 'relationships' | 'situation'>
  catalog?: { maxCatalogBytes?: number; maxSourceBytes?: number; receiptTtlMs?: number; maxReceipts?: number }
}
export interface WorldDevelopmentAgent { run(input: AgentLoopInput): Promise<AgentLoopResult>; cancel(): void; dispose(): Promise<void> }

/** 创建独立世界发展规划 Agent；调用方必须等待释放。 */
export function createWorldDevelopmentAgent(config: WorldDevelopmentAgentConfig): Promise<WorldDevelopmentAgent> { return createWorldDevelopmentAgentWithCatalogBinding(config) }

/** 使用外部目录绑定时不拥有目录服务及引用句柄。 */
export async function createWorldDevelopmentAgentWithCatalogBinding(config: WorldDevelopmentAgentConfig, createCatalogBinding?: () => CatalogBinding, borrowedStore?: DevelopmentStore): Promise<WorldDevelopmentAgent> {
  if (config?.singleWriterProcess !== true) throw new Error('必须确保同一世界仅由一个可信应用进程写入')
  for (const value of [config.worldId, config.agentId, config.sessionId, config.provider, config.model]) {
    if (typeof value !== 'string' || !value || value.trim() !== value) throw new Error('世界发展规划 Agent 身份和模型配置必须非空且无首尾空白')
  }
  if (config.sessionMode !== 'create' && config.sessionMode !== 'resume') throw new Error('Session 模式无效')
  if (createCatalogBinding && config.catalog) throw new Error('不能同时提供目录服务与目录绑定')
  const worlds = await validateWorldWorkspaceConfigs(config.workspaces); const world = worlds.find(item => item.worldId === config.worldId)
  if (!world) throw new Error('世界配置不存在')
  const owner = world.agents.find(item => item.agentId === config.agentId)
  if (!owner) throw new Error('世界发展规划 Agent 身份不属于该世界的特殊 Agent')
  if (borrowedStore && (borrowedStore.worldId !== world.worldId || borrowedStore.rootDirectory !== owner.writableRoot || !borrowedStore.writable)) throw new Error('共享规划存储与可信世界、负责人或写入权限不匹配')
  if (typeof config.sessionRoot !== 'string' || !isAbsolute(config.sessionRoot)) throw new Error('Session 目录必须是绝对路径')
  const sessionRoot = await realpath(config.sessionRoot)
  if (sessionRoot !== resolve(config.sessionRoot) || !(await stat(sessionRoot)).isDirectory()) throw new Error('Session 目录必须是现有真实目录')
  for (const item of worlds) if (await isPathUnder(sessionRoot, item.readRoot) || await isPathUnder(item.readRoot, sessionRoot)) throw new Error('Session 目录不能与任何世界读取根重叠')
  const sessionId = `world-development-agent-${createHash('sha256').update(JSON.stringify([world.worldId, owner.agentId, config.sessionId])).digest('hex')}`
  const references = await createWorldDevelopmentResolvers({ ...config.references, workspaces: worlds, worldId: world.worldId })
  const releaseIdentity = acquireWorldAgentLease(world.worldId, owner.agentId)
  let catalog: CatalogService | undefined; let binding: CatalogBinding | undefined; let store: DevelopmentStore | undefined; let agent: Agent | undefined
  let developmentBackend: ReturnType<Context['plugin']> | undefined; let closeFramework: (() => Promise<void>) | undefined
  try {
    if (config.catalog) catalog = await CatalogService.open(world, { singleWriterProcess: true, ...config.catalog })
    if (borrowedStore) store = borrowedStore
    else {
      const developmentContext = new Context(); developmentBackend = developmentContext.plugin(LocalFileSystem, { cwd: world.readRoot }); await developmentBackend
      store = await DevelopmentStore.open({ fs: developmentContext.fs, root: owner.writableRoot, worldId: world.worldId, access: 'read-write', phase: 'initialization', singleWriterProcess: true, ...references })
    }
    const framework = await bootstrapAgents()
    for (const definition of [sandboxPolicyPluginDefinition, worldInitializationDraftFsPluginDefinition, fsObservationPolicyPluginDefinition,
      toolFsReadPluginDefinition, toolFsSearchPluginDefinition, localSubprocessPluginDefinition, developmentToolsPluginDefinition]) framework.plugins.register(definition)
    const base = framework.presets.get('world-development-agent'); const presetId = 'world-development-agent-workspace'
    framework.presets.register({ ...base, id: presetId, plugins: [...base.plugins,
      { pluginId: 'sandbox-policy' }, { pluginId: 'world-initialization-draft-fs' }, { pluginId: 'fs-observation-policy' },
      { pluginId: 'subprocess-local' }, { pluginId: 'tool-fs-read' }, { pluginId: 'tool-fs-search' }, { pluginId: 'world-development-tools' },
    ] })
    const backend = framework.context.plugin(jsonlSessionPersistencePlugin, { root: sessionRoot })
    closeFramework = async () => { await framework.manager.disposeAll(); await backend.dispose() }; await backend
    agent = await framework.manager.create({ id: owner.agentId, presetId, pluginConfigs: {
      'agent-loop-runtime': { provider: config.provider, model: config.model, workingDirectory: world.readRoot,
        ...(config.sessionMode === 'create' ? { sessionId } : { resumeSessionId: sessionId }) },
      'sandbox-policy': { mode: 'workspace-write', workspaceRoot: owner.writableRoot },
      'world-initialization-draft-fs': { cwd: world.readRoot, draftRoot: owner.writableRoot },
      'world-development-tools': { store, access: 'read-write' }, llm: { adapters: [{ providers: [config.provider], adapter: config.adapter }] },
    } })
    const identity = agent.context.tools.agent
    if (!identity) throw new Error('世界发展规划 Agent 工具缺少身份')
    agent.context.tools.register(readFileTool)
    if (config.references?.situation) for (const tool of createSituationTools(config.references.situation.store, identity, 'read-only')) agent.context.tools.register(tool)
    if (config.references?.map) for (const tool of createMapTools(config.references.map.store, identity, 'read-only')) agent.context.tools.register(tool)
    if (config.references?.organization) for (const tool of createOrganizationTools(config.references.organization.store, identity, { kind: 'planner', worldId: world.worldId }, 'read-only')) agent.context.tools.register(tool)
    if (config.references?.history) for (const tool of createHistoryTools(config.references.history.store, identity, 'read-only')) agent.context.tools.register(tool)
    if (config.references?.characters) for (const tool of createCharacterReadTools(config.references.characters.store)) {
      if (['character_search', 'character_read', 'character_read_many'].includes(tool.name)) agent.context.tools.register(tool)
    }
    if (config.references?.relationships && config.references.characters) {
      const characters = config.references.characters.store
      for (const tool of createCharacterRelationshipReadTools(config.references.relationships.store, { worldId: world.worldId, async resolvePerson(id, signal) {
        signal.throwIfAborted(); const records = await characters.query({}); if (!records.some(item => item.id === id)) return null
        const value = await characters.read(id); signal.throwIfAborted(); return { id: value.metadata.id, name: value.metadata.name, worldId: world.worldId }
      } })) if (['character_relationship_read', 'character_relationship_search'].includes(tool.name)) agent.context.tools.register(tool)
    }
    const prefix = relative(world.readRoot, owner.writableRoot).split(sep).join('/')
    agent.context.systemPrompt.section({ name: 'world-development-agent:workspace', order: 10, interpolate: false,
      text: `世界资料读取根：${JSON.stringify(world.readRoot)}。世界发展规划资料目录相对该根为 ${JSON.stringify(prefix)}；规划工具返回路径相对于该目录，登记目录时应加此前缀。` })
    if (catalog || createCatalogBinding) {
      binding = catalog ? catalog.bind(owner.agentId) : createCatalogBinding?.()
      if (!binding) throw new Error('世界发展规划 Agent 目录绑定不可用')
      for (const tool of createCatalogTools(binding, identity)) agent.context.tools.register(tool)
    }
    const created = agent; const developmentStore = store; const close = closeFramework; const backendScope = developmentBackend
    let disposal: Promise<void> | undefined
    return { run: input => created.run(input), cancel: () => created.cancel(),
      dispose: () => disposal ??= (async () => { await created.dispose(); if (!borrowedStore) await developmentStore.close(); await backendScope?.dispose(); await close(); await binding?.close(); await catalog?.close(); releaseIdentity() })() }
  } catch (error) {
    try { await agent?.dispose(); if (!borrowedStore) await store?.close(); await developmentBackend?.dispose(); await closeFramework?.(); await binding?.close(); await catalog?.close(); if (!(error instanceof AggregateError)) releaseIdentity() }
    catch (cleanup) { throw new AggregateError([error, cleanup], '世界发展规划 Agent 启动及清理失败') }
    throw error
  }
}
