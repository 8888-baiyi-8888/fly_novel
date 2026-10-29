import type { AgentPreset } from '../core/contracts/index.js'

export const writerAgentPreset: AgentPreset = {
  id: 'writer-agent',
  version: '1.0.0',
  description: '写作 Agent 的基础插件配置',
  role: 'writer',
  plugins: [
    { pluginId: 'agent-loop-runtime' },
    { pluginId: 'system-prompt' },
    { pluginId: 'writer-system-prompt' },
    { pluginId: 'llm' },
    { pluginId: 'session' },
  ],
}
