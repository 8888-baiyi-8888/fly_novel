import type { AgentPreset } from '../core/contracts/index.js'

/** 历史存储和工具由可信应用装配。 */
export const historyAgentPreset: AgentPreset = {
  id: 'history-agent', version: '1.0.0', description: '开发世界历史设定的 Agent', role: 'general',
  plugins: [
    { pluginId: 'agent-loop-runtime' }, { pluginId: 'system-prompt' }, { pluginId: 'history-agent-system-prompt' },
    { pluginId: 'llm' }, { pluginId: 'session' }, { pluginId: 'tools' },
  ],
}
