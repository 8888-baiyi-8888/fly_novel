import type { AgentPreset } from '../core/contracts/index.js'

export const directorAgentPreset: AgentPreset = {
  id: 'director-agent',
  version: '1.0.0',
  description: '导演 Agent 的基础插件配置',
  role: 'director',
  defaultParameters: {
    temperature: 0.5,
  },
  plugins: [
    { pluginId: 'agent-loop-runtime' },
    { pluginId: 'system-prompt' },
    { pluginId: 'director-system-prompt' },
    { pluginId: 'llm' },
    { pluginId: 'session' },
    {
      pluginId: 'mock-memory',
      config: {
        initial: {},
      },
    },
  ],
}
