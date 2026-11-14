import { createHash, randomUUID } from 'node:crypto'
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
import { defineTool } from '@fly-novel/tools'
import type { LlmAdapter } from '@fly-novel/llm'
import { createCatalogTools, readFileTool } from '../../tools/index.js'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../../world-init/workspace/config.js'
import { acquireWorldAgentLease } from '../../world-init/workspace/agent-lease.js'
import { CatalogService, type CatalogBinding } from '../../world-init/workspace/catalog/service.js'
import { worldInitializationDraftFsPluginDefinition } from './world-initialization-draft-fs.js'

/** 可信调用方指定世界、身份、持久会话和模型；所有目录必须已经存在。 */
export interface WorldBasicsConfig {
  workspaces: readonly WorldWorkspaceConfig[]
  worldId: string
  agentId: string
  sessionId: string
  sessionMode: 'create' | 'resume'
  sessionRoot: string
  provider: string
  model: string
  adapter: LlmAdapter
  singleWriterProcess: true
  catalog?: { maxCatalogBytes?: number; maxSourceBytes?: number; receiptTtlMs?: number; maxReceipts?: number }
}

/** 调用方拥有此句柄，使用后必须等待 dispose。 */
export interface WorldBasicsAgent {
  run(input: AgentLoopInput): Promise<AgentLoopResult>
  cancel(): void
  dispose(): Promise<void>
}

/**
 * 创建独立世界基础信息 Agent；资料目录和身份由可信世界配置绑定。
 * @param config 包含所有本次装配范围内的世界、会话和模型配置。
 * @returns 管理 Agent、会话和可选目录服务的句柄。
 * @throws 配置无效、身份占用或启动失败时拒绝，不删除已有成果。
 */
export async function createWorldBasicsAgent(config: WorldBasicsConfig): Promise<WorldBasicsAgent> {
  return createWorldBasicsAgentWithCatalogBinding(config)
}

/** 由拥有世界目录服务的可信装配方提供绑定；调用方负责该服务的生命周期。 */
export async function createWorldBasicsAgentWithCatalogBinding(config: WorldBasicsConfig, createCatalogBinding?: () => CatalogBinding): Promise<WorldBasicsAgent> {
  if (config?.singleWriterProcess !== true) throw new Error('必须确保同一世界仅由一个可信应用进程写入')
  for (const value of [config.worldId, config.agentId, config.sessionId, config.provider, config.model]) {
    if (typeof value !== 'string' || !value || value.trim() !== value) throw new Error('世界基础信息 Agent 身份和模型配置必须非空且无首尾空白')
  }
  if (config.sessionMode !== 'create' && config.sessionMode !== 'resume') throw new Error('Session 模式无效')
  const worlds = await validateWorldWorkspaceConfigs(config.workspaces)
  const world = worlds.find(item => item.worldId === config.worldId)
  if (!world) throw new Error('世界配置不存在')
  const owner = world.agents.find(item => item.agentId === config.agentId)
  if (!owner) throw new Error('世界基础信息 Agent 身份不属于该世界的特殊 Agent')
  if (typeof config.sessionRoot !== 'string' || !isAbsolute(config.sessionRoot)) throw new Error('Session 目录必须是绝对路径')
  const sessionRoot = await realpath(config.sessionRoot)
  if (sessionRoot !== resolve(config.sessionRoot) || !(await stat(sessionRoot)).isDirectory()) throw new Error('Session 目录必须是现有真实目录')
  for (const item of worlds) {
    if (await isPathUnder(sessionRoot, item.readRoot) || await isPathUnder(item.readRoot, sessionRoot)) throw new Error('Session 目录不能与任何世界读取根重叠')
  }
  const sessionId = `world-basics-${createHash('sha256').update(JSON.stringify([world.worldId, owner.agentId, config.sessionId])).digest('hex')}`
  const releaseIdentity = acquireWorldAgentLease(world.worldId, owner.agentId)
  let disposeFramework: (() => Promise<void>) | undefined
  let catalog: CatalogService | undefined
  let binding: CatalogBinding | undefined
  try {
    if (createCatalogBinding && config.catalog) throw new Error('不能同时提供目录服务与目录绑定')
    if (config.catalog) catalog = await CatalogService.open(world, { singleWriterProcess: true, ...config.catalog })
    const framework = await bootstrapAgents()
    for (const definition of [sandboxPolicyPluginDefinition, worldInitializationDraftFsPluginDefinition, fsObservationPolicyPluginDefinition,
      toolFsReadPluginDefinition, toolFsSearchPluginDefinition, localSubprocessPluginDefinition]) framework.plugins.register(definition)
    const base = framework.presets.get('world-basics')
    const presetId = 'world-basics-workspace'
    framework.presets.register({ ...base, id: presetId, plugins: [...base.plugins,
      { pluginId: 'sandbox-policy' }, { pluginId: 'world-initialization-draft-fs' }, { pluginId: 'fs-observation-policy' },
      { pluginId: 'subprocess-local' }, { pluginId: 'tool-fs-read' }, { pluginId: 'tool-fs-search' },
    ] })
    const backend = framework.context.plugin(jsonlSessionPersistencePlugin, { root: sessionRoot })
    disposeFramework = async () => { await framework.manager.disposeAll(); await backend.dispose() }
    await backend
    const agent: Agent = await framework.manager.create({ id: owner.agentId, presetId, pluginConfigs: {
      'agent-loop-runtime': { provider: config.provider, model: config.model, workingDirectory: world.readRoot,
        ...(config.sessionMode === 'create' ? { sessionId } : { resumeSessionId: sessionId }) },
      'sandbox-policy': { mode: 'workspace-write', workspaceRoot: owner.writableRoot },
      'world-initialization-draft-fs': { cwd: world.readRoot, draftRoot: owner.writableRoot },
      llm: { adapters: [{ providers: [config.provider], adapter: config.adapter }] },
    } })
    agent.context.tools.register(readFileTool)
    const root = relative(world.readRoot, owner.writableRoot).split(sep).join('/')
    agent.context.tools.register(defineTool({
      name: 'save_world_basics', description: '保存待审世界基础信息；创建独立文件，不覆盖已有成果。', reportOnAbort: true,
      parameters: { content: { type: 'string', required: true, description: '包含来源、建议和留白的基础信息正文。' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', enum: ['saved', 'unknown'], required: true }, path: { type: 'string', required: true }, reason: { type: 'string' },
      } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute({ content }, exec) {
        if (!content.trim()) throw new Error('基础信息正文不能为空')
        exec.signal.throwIfAborted()
        const path = `${root}/world-basics-${randomUUID()}.md`
        const target = await agent.context.fs.resolve(path, { cwd: world.readRoot, signal: exec.signal })
        try {
          const outcome = await agent.context.fs.writeText(target, `# 世界基础信息（待审）\n\n${content.trim()}\n`, { kind: 'createIfAbsent' }, exec.signal)
          agent.context.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
          return { status: 'saved' as const, path }
        } catch (error) {
          return { status: 'unknown' as const, path, reason: error instanceof Error ? error.message : String(error) }
        }
      },
    }))
    if (catalog || createCatalogBinding) {
      binding = catalog ? catalog.bind(owner.agentId) : createCatalogBinding?.()
      if (!binding) throw new Error('世界基础信息目录绑定不可用')
      const identity = agent.context.tools.agent
      if (!identity) throw new Error('世界基础信息 Agent 的目录工具缺少身份')
      for (const tool of createCatalogTools(binding, identity)) agent.context.tools.register(tool)
    }
    const closeFramework = disposeFramework
    let disposal: Promise<void> | undefined
    return {
      run: input => agent.run(input), cancel: () => agent.cancel(),
      dispose: () => disposal ??= (async () => { await closeFramework(); await binding?.close(); await catalog?.close(); releaseIdentity() })(),
    }
  } catch (error) {
    try {
      await disposeFramework?.(); await binding?.close(); await catalog?.close()
      if (!(error instanceof AggregateError)) releaseIdentity()
    } catch (cleanup) { throw new AggregateError([error, cleanup], '世界基础信息 Agent 启动及清理失败') }
    throw error
  }
}
