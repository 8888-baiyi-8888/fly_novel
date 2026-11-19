import type { AgentPreset } from '../core/contracts/index.js'

/** 局势存储和工具由可信应用装配。 */
export const initialSituationAgentPreset: AgentPreset = {
  id: 'initial-situation-agent', version: '1.0.0', description: '开发世界初始局势的 Agent', role: 'general',
  plugins: [
    { pluginId: 'agent-loop-runtime' }, { pluginId: 'system-prompt' }, { pluginId: 'initial-situation-agent-system-prompt' },
    { pluginId: 'llm' }, { pluginId: 'session' }, { pluginId: 'tools' },
  ],
}
