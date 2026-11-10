import { isAbsolute, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { bootstrapAgents, jsonlSessionPersistencePlugin, type Agent } from '@fly-novel/agents'
import type { AgentLoopInput, AgentLoopResult } from '@fly-novel/agent-loop'
import { isPathUnder } from '@fly-novel/fs-sandbox'
import { fsSandboxPluginDefinition } from '@fly-novel/fs-sandbox'
import { sandboxPolicyPluginDefinition } from '@fly-novel/sandbox-policy'
import { fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import { toolFsReadPluginDefinition } from '@fly-novel/tool-fs'
import { toolFsSearchPluginDefinition } from '@fly-novel/tool-fs-search'
import { localSubprocessPluginDefinition } from '@fly-novel/subprocess-local'
import type { LlmAdapter } from '@fly-novel/llm'
import { createCharacterTools, readFileTool } from '../../tools/index.js'
import { CharacterStore } from '../../world-init/character/store.js'
import { acquireWorldAgentLease } from '../../world-init/workspace/agent-lease.js'

/** 由可信应用提供身份、存储及模型路由。所有目录必须已经存在。 */
export interface CharacterCreatorConfig {
  worldId: string
  agentId: string
  sessionId: string
  sessionMode: 'create' | 'resume'
  sessionRoot: string
  characterRoot: string
  initializeCharacters: boolean
  readRoot: string
  provider: string
  model: string
  adapter: LlmAdapter
  defaultCharacterCount: number
}

/** 调用方拥有该句柄，必须在使用后等待 dispose。 */
export interface CharacterCreator {
  run(input: AgentLoopInput): Promise<AgentLoopResult>
  cancel(): void
  dispose(): Promise<void>
}

const sessions = new Set<string>()

async function physicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('角色创建 Agent 目录必须是绝对路径')
  const actual = await realpath(path)
  if (actual !== resolve(path) || !(await stat(actual)).isDirectory()) throw new Error('角色创建 Agent 目录必须是现有真实目录')
  return actual
}

/**
 * 创建独立角色创建 Agent，复用 JSONL Session 和可信角色资料工具。
 * @param config 可信应用提供的身份、目录、会话模式和模型配置。
 * @returns 负责 Agent、Session 后端和资料服务生命周期的句柄。
 * @throws 配置无效、身份占用或初始化失败时拒绝；不会删除已有资料。
 */
export async function createCharacterCreator(config: CharacterCreatorConfig): Promise<CharacterCreator> {
  for (const value of [config.worldId, config.agentId, config.sessionId, config.provider, config.model]) {
    if (!value || value.trim() !== value) throw new Error('角色创建 Agent 身份和模型配置必须非空且无首尾空白')
  }
  if (config.sessionMode !== 'create' && config.sessionMode !== 'resume') throw new Error('Session 模式无效')
  if (!Number.isSafeInteger(config.defaultCharacterCount) || config.defaultCharacterCount < 1) throw new Error('角色默认生成数量必须是正整数')
  const [readRoot, characterRoot, sessionRoot] = await Promise.all([
    physicalDirectory(config.readRoot), physicalDirectory(config.characterRoot), physicalDirectory(config.sessionRoot),
  ])
  if (!await isPathUnder(characterRoot, readRoot)) throw new Error('角色目录必须位于读取范围内')
  if (await isPathUnder(sessionRoot, readRoot) || await isPathUnder(readRoot, sessionRoot)) throw new Error('Session 目录不能与读取范围重叠')
  const storageSessionId = `character-creator-${createHash('sha256').update(JSON.stringify([config.worldId, config.agentId, config.sessionId])).digest('hex')}`
  const sessionKey = JSON.stringify([sessionRoot, storageSessionId])
  if (sessions.has(sessionKey)) throw new Error('角色创建 Agent Session 正在使用')
  const releaseIdentity = acquireWorldAgentLease(config.worldId, config.agentId)
  sessions.add(sessionKey)
  const unlock = () => { releaseIdentity(); sessions.delete(sessionKey) }
  let store: CharacterStore | undefined
  let agent: Agent | undefined
  let disposeFramework: (() => Promise<void>) | undefined
  try {
    store = await CharacterStore.open(characterRoot, config.initializeCharacters)
    const framework = await bootstrapAgents()
    for (const definition of [sandboxPolicyPluginDefinition, fsSandboxPluginDefinition, fsObservationPolicyPluginDefinition,
      toolFsReadPluginDefinition, toolFsSearchPluginDefinition, localSubprocessPluginDefinition]) framework.plugins.register(definition)
    const base = framework.presets.get('character-creator')
    const presetId = 'character-creator-world-read'
    framework.presets.register({ ...base, id: presetId, plugins: [...base.plugins,
      { pluginId: 'sandbox-policy' }, { pluginId: 'fs-sandbox' }, { pluginId: 'fs-observation-policy' },
      { pluginId: 'subprocess-local' }, { pluginId: 'tool-fs-read' }, { pluginId: 'tool-fs-search' },
    ] })
    const backend = framework.context.plugin(jsonlSessionPersistencePlugin, { root: sessionRoot })
    disposeFramework = async () => {
      await framework.manager.disposeAll()
      await backend.dispose()
    }
    await backend
    agent = await framework.manager.create({ id: config.agentId, presetId, pluginConfigs: {
      'agent-loop-runtime': { provider: config.provider, model: config.model, workingDirectory: readRoot,
        ...(config.sessionMode === 'create' ? { sessionId: storageSessionId } : { resumeSessionId: storageSessionId }) },
      'sandbox-policy': { mode: 'read-only', workspaceRoot: readRoot }, 'fs-sandbox': { cwd: readRoot },
      llm: { adapters: [{ providers: [config.provider], adapter: config.adapter }] },
      'character-creator-system-prompt': { defaultCharacterCount: config.defaultCharacterCount },
    } })
    for (const tool of [...createCharacterTools(store), readFileTool]) agent.context.tools.register(tool)
    const current = agent
    const ownedStore = store
    const disposeOwnedFramework = disposeFramework
    let disposal: Promise<void> | undefined
    return {
      run: input => current.run(input),
      cancel: () => current.cancel(),
      dispose: () => disposal ??= (async () => {
        await disposeOwnedFramework()
        await ownedStore.close()
        unlock()
      })(),
    }
  } catch (error) {
    try {
      await disposeFramework?.()
      await store?.close()
      if (!(error instanceof AggregateError)) unlock()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], '角色创建 Agent 启动及清理失败')
    }
    throw error
  }
}
