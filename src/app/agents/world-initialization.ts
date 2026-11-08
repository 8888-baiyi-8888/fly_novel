import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { bootstrapAgents, createSpawnAgentCreator, type Agent } from '@fly-novel/agents'
import { sandboxPolicyPluginDefinition } from '@fly-novel/sandbox-policy'
import { fsSandboxPluginDefinition } from '@fly-novel/fs-sandbox'
import { fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import { toolFsPluginDefinition, toolFsReadPluginDefinition } from '@fly-novel/tool-fs'
import { toolFsSearchPluginDefinition } from '@fly-novel/tool-fs-search'
import { localSubprocessPluginDefinition } from '@fly-novel/subprocess-local'
import { registerAll } from '@fly-novel/util'
import { loadConfiguredAdapter } from '../call-llm.js'
import { readFileTool } from '../../tools/index.js'
import { validateWorldInitializationWorkspace, type WorldInitializationWorkspace } from './world-initialization-workspace.js'
import { worldInitializationDraftFsPluginDefinition } from './world-initialization-draft-fs.js'
import { worldInitializationSkillPluginDefinition } from './world-initialization-skill.js'
import { worldInitializationWorkspacePromptPluginDefinition } from './world-initialization-workspace-prompt.js'

/** 此 Agent 除插件自动注册的工具外，还需要的具体工具。 */
const worldInitializationTools = [readFileTool] as const

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
 * @returns 初始化完成的 Agent；调用方使用完毕后须调用 dispose()。
 */
export async function createWorldInitializationAgentWithWorkspace(workspace: WorldInitializationWorkspace): Promise<Agent> {
  const roots = await validateWorldInitializationWorkspace(workspace)
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
  ] })
  const modelConfig = { adapters: [{ providers: [provider], adapter }] }
  const loopConfig = { provider, model, workingDirectory: roots.viewRoot }
  const create = createSpawnAgentCreator(framework, { [fileChildId]: {
    'agent-loop-runtime': loopConfig, llm: modelConfig,
    'sandbox-policy': { mode: 'read-only', workspaceRoot: roots.viewRoot }, 'fs-sandbox': { cwd: roots.viewRoot },
    'world-initialization-workspace-prompt': { ...roots, mode: 'read-only' },
  } })
  return framework.factory.create({ id: `world-initialization-${randomUUID()}`, presetId: mainId, pluginConfigs: {
    'agent-loop-runtime': loopConfig, llm: modelConfig, 'world-initialization-skill-source': { root: skillRoot },
    'sandbox-policy': { mode: 'workspace-write', workspaceRoot: roots.draftRoot },
    'world-initialization-draft-fs': { cwd: roots.viewRoot, draftRoot: roots.draftRoot },
    'world-initialization-workspace-prompt': { ...roots, mode: 'draft-write' },
    'tool-fs': { applyPatch: true }, 'subagent-spawn-in-process': { create }, 'tool-subagent': { presetId: fileChildId },
  } })
}
