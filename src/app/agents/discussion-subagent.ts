import { createHash } from 'node:crypto'
import { bootstrapAgents, jsonlSessionPersistencePlugin } from '@fly-novel/agents'
import type { LlmAdapter } from '@fly-novel/llm'
import { sandboxPolicyPluginDefinition } from '@fly-novel/sandbox-policy'
import { fsSandboxPluginDefinition } from '@fly-novel/fs-sandbox'
import { fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import { toolFsReadPluginDefinition } from '@fly-novel/tool-fs'
import { toolFsSearchPluginDefinition } from '@fly-novel/tool-fs-search'
import { localSubprocessPluginDefinition } from '@fly-novel/subprocess-local'
import { acquireWorldAgentLease } from '../../world-init/workspace/agent-lease.js'

/**
 * 创建只读讨论子 Agent，不接收初始化存储或写工具。
 * @param config 可信应用绑定的世界、身份、会话和模型配置。
 * @returns Agent 与释放句柄；调用方必须等待 dispose。
 * @throws 身份占用、Session 或 Agent 装配失败时拒绝；清理失败保留身份占用。
 */
export async function createDiscussionSubagent(config: {
  worldId: string; agentId: string; presetId: string; readRoot: string; sessionRoot: string; sessionId: string
  sessionMode: 'create' | 'resume'; provider: string; model: string; adapter: LlmAdapter; maxSteps?: number
}) {
  const release = acquireWorldAgentLease(config.worldId, config.agentId)
  let cleanup: (() => Promise<void>) | undefined
  try {
    const framework = await bootstrapAgents()
    for (const definition of [sandboxPolicyPluginDefinition, fsSandboxPluginDefinition, fsObservationPolicyPluginDefinition,
      toolFsReadPluginDefinition, toolFsSearchPluginDefinition, localSubprocessPluginDefinition]) framework.plugins.register(definition)
    const base = framework.presets.get(config.presetId)
    const presetId = `${config.presetId}-discussion-readonly`
    framework.presets.register({ ...base, id: presetId, plugins: [...base.plugins,
      { pluginId: 'sandbox-policy' }, { pluginId: 'fs-sandbox' }, { pluginId: 'fs-observation-policy' },
      { pluginId: 'subprocess-local' }, { pluginId: 'tool-fs-read' }, { pluginId: 'tool-fs-search' }] })
    const backend = framework.context.plugin(jsonlSessionPersistencePlugin, { root: config.sessionRoot })
    cleanup = async () => { await framework.manager.disposeAll(); await backend.dispose() }
    await backend
    const sessionId = `discussion-${createHash('sha256').update(JSON.stringify([config.worldId, config.agentId, config.sessionId])).digest('hex')}`
    const agent = await framework.manager.create({ id: config.agentId, presetId, pluginConfigs: {
      'agent-loop-runtime': { provider: config.provider, model: config.model, workingDirectory: config.readRoot, maxSteps: config.maxSteps,
        ...(config.sessionMode === 'create' ? { sessionId } : { resumeSessionId: sessionId }) },
      llm: { adapters: [{ providers: [config.provider], adapter: config.adapter }] },
      'sandbox-policy': { mode: 'read-only', workspaceRoot: config.readRoot }, 'fs-sandbox': { cwd: config.readRoot },
    } })
    let disposal: Promise<void> | undefined
    return { agent, dispose: () => disposal ??= (async () => { await cleanup!(); release() })() }
  } catch (error) {
    try { await cleanup?.(); if (!(error instanceof AggregateError)) release() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], '讨论子 Agent 启动及清理失败') }
    throw error
  }
}
