import type { AgentPreset } from '../core/contracts/index.js'

export const characterAgentPreset: AgentPreset = {
  id: 'character-agent',
  version: '1.0.0',
  description: '角色 Agent 的基础插件配置',
  role: 'character',
  defaultParameters: {
    temperature: 0.7,
  },
  plugins: [
    { pluginId: 'agent-loop-runtime' },
    { pluginId: 'system-prompt' },
    { pluginId: 'llm' },
    { pluginId: 'session' },
    {
      pluginId: 'mock-memory',
      config: {
        initial: {},
      },
    },
    {
      pluginId: 'character-example-memory',
    },
  ],
}
