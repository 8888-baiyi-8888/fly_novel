import { createHash, randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
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
import { createCatalogTools, createCharacterCreatorDelegationTool, readFileTool } from '../../tools/index.js'
import { createCharacterCreator, type CharacterCreatorConfig } from './character-creator.js'
import { createWorldBasicsAgentWithCatalogBinding, type WorldBasicsConfig } from './world-basics.js'
import { createWorldBasicsDelegationTool } from '../../tools/world-basics/delegate-world-basics.js'
import { validateWorldInitializationWorkspace, type WorldInitializationWorkspace } from './world-initialization-workspace.js'
import { worldInitializationDraftFsPluginDefinition } from './world-initialization-draft-fs.js'
import { worldInitializationSkillPluginDefinition } from './world-initialization-skill.js'
import { worldInitializationWorkspacePromptPluginDefinition } from './world-initialization-workspace-prompt.js'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../../world-init/workspace/config.js'
import { acquireWorldAgentLease } from '../../world-init/workspace/agent-lease.js'
import { CatalogService, type CatalogBinding } from '../../world-init/workspace/catalog/service.js'

/** 此 Agent 除插件自动注册的工具外，还需要的具体工具。 */
const worldInitializationTools = [readFileTool] as const

/** 角色创建 Agent 的非授权配置；世界和目录由工作区绑定。 */
export type WorkspaceCharacterCreatorConfig = Omit<CharacterCreatorConfig, 'worldId' | 'readRoot' | 'characterRoot' | 'createCatalogBinding'>

/** 基础信息 Agent 的非授权配置；世界和目录由工作区绑定。 */
export type WorkspaceWorldBasicsConfig = Omit<WorldBasicsConfig, 'workspaces' | 'worldId' | 'singleWriterProcess' | 'catalog'>

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
  deployment: { readonly singleWriterProcess: true; readonly catalog?: { readonly maxCatalogBytes?: number; readonly maxSourceBytes?: number; readonly receiptTtlMs?: number; readonly maxReceipts?: number }; readonly mainSession?: WorldInitializationSessionConfig; readonly worldBasics?: WorkspaceWorldBasicsConfig },
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
    creator = { ...characterCreator, worldId: world.worldId, readRoot: world.readRoot, characterRoot: owner.writableRoot, createCatalogBinding: undefined }
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
      basics, catalog && basics ? () => catalog!.bind(basics!.agentId) : undefined)
  } catch (error) {
    if (!(error instanceof AggregateError)) {
      try { await mainBinding?.close(); await catalog?.close(); releaseIdentity() } catch (cleanup) { throw new AggregateError([error, cleanup], '工作区装配和目录服务清理失败') }
    }
    throw error
  }
  let disposal: Promise<void> | undefined
  return {
    info: agent.info, context: agent.context,
    get state() { return agent.state },
    run: input => agent.run(input), cancel: () => agent.cancel(),
    dispose: () => disposal ??= (async () => { await agent.dispose(); await mainBinding?.close(); await catalog?.close(); releaseIdentity() })(),
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
  basicsConfig?: WorldBasicsConfig, createBasicsCatalogBinding?: () => CatalogBinding): Promise<Agent> {
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
    ...(creatorConfig || basicsConfig ? [{ pluginId: 'subagent-persistent-in-process' }] : []),
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
      const child = await createCharacterCreator({ ...creatorConfig, sessionMode, initializeCharacters: initial && creatorConfig.initializeCharacters })
      return { agent: child, dispose: () => child.dispose() }
    } })
  const basicsCreate = basicsConfig && createPersistentAgentCreator({ presetId: 'world-basics', sessionMode: basicsConfig.sessionMode,
    async create({ sessionMode }) {
      const child = await createWorldBasicsAgentWithCatalogBinding({ ...basicsConfig, sessionMode }, createBasicsCatalogBinding)
      return { agent: child, dispose: () => child.dispose() }
    } })
  const routes = { ...(characterCreate ? { 'character-creator': characterCreate } : {}), ...(basicsCreate ? { 'world-basics': basicsCreate } : {}) }
  const persistentCreate = characterCreate || basicsCreate ? createPersistentAgentRouter(routes) : undefined
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
    'world-initialization-workspace-prompt': { ...roots, mode: 'draft-write', worldBasics: Boolean(basicsConfig), ...(catalogBinding && catalogMainOwner ? { catalog: {
      mainOwner: catalogMainOwner, delegates: [...(creatorConfig ? [{ owner: creatorConfig.agentId, tool: 'delegate_character_creator' }] : []),
        ...(basicsConfig ? [{ owner: basicsConfig.agentId, tool: 'delegate_world_basics' }] : [])],
    } } : {}) },
    'tool-fs': { applyPatch: true }, 'subagent-spawn-in-process': { create }, 'tool-subagent': { presetId: fileChildId },
    ...(persistentCreate ? { 'subagent-persistent-in-process': { create: persistentCreate } } : {}),
    } })
    if (creatorConfig) agent.context.tools.register(createCharacterCreatorDelegationTool(agent.context.subagents, agent.info.identity.id))
    if (basicsConfig) agent.context.tools.register(createWorldBasicsDelegationTool(agent.context.subagents, agent.info.identity.id))
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
