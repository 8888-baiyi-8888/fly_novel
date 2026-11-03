import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { bootstrapAgents, type Agent } from '@fly-novel/agents'
import { registerAll } from '@fly-novel/util'
import { loadConfiguredAdapter } from '../call-llm.js'
import { readFileTool } from '../../tools/index.js'

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
