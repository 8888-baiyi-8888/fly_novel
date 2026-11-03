import { randomUUID } from 'node:crypto'
import { bootstrapAgents, type Agent } from '@fly-novel/agents'
import { registerAll } from '@fly-novel/util'
import { loadConfiguredAdapter } from '../call-llm.js'
import type { ToolDefinition } from '@fly-novel/tools'

/** 写作 Agent 自身需要注册的工具。 */
const writerTools: readonly ToolDefinition[] = []

/** 使用本机模型配置创建写作 Agent；调用方负责销毁返回的实例。 */
export async function createWriterAgent(): Promise<Agent> {
  const { provider, model, adapter } = await loadConfiguredAdapter('deepseek')
  const { factory } = await bootstrapAgents()
  const agent = await factory.create({
    id: `writer-${randomUUID()}`,
    presetId: 'writer-agent',
    pluginConfigs: {
      'agent-loop-runtime': { provider, model, workingDirectory: process.cwd() },
      llm: { adapters: [{ providers: [provider], adapter }] },
    },
  })
  registerAll(writerTools, tool => {
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
