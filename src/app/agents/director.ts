import { randomUUID } from 'node:crypto'
import { bootstrapAgents, type Agent } from '@fly-novel/agents'
import { registerAll } from '@fly-novel/util'
import { loadConfiguredAdapter } from '../call-llm.js'
import type { ToolDefinition } from '@fly-novel/tools'

/** 导演 Agent 自身需要注册的工具。 */
const directorTools: readonly ToolDefinition[] = []

/** 使用本机模型配置创建导演 Agent；调用方负责销毁返回的实例。 */
export async function createDirectorAgent(): Promise<Agent> {
  const { provider, model, adapter } = await loadConfiguredAdapter('deepseek')
  const { factory } = await bootstrapAgents()
  const agent = await factory.create({
    id: `director-${randomUUID()}`,
    presetId: 'director-agent',
    pluginConfigs: {
      'agent-loop-runtime': { provider, model, workingDirectory: process.cwd() },
      llm: { adapters: [{ providers: [provider], adapter }] },
    },
  })
  registerAll(directorTools, tool => {
    try {
      const tools = agent.context.tools
      if (!tools) throw new Error('Agent 未装配工具服务')
      tools.register(tool)
    } catch (error) {
      console.error(`工具 "${tool.name}" 注册失败：`, error)
    }
  })
  return agent
}
