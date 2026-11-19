import type { AgentPreset } from '../core/contracts/index.js'

/** 专有内容存储和工具由可信应用装配。 */
export const worldSpecificAgentPreset: AgentPreset = {
  id: 'world-specific-agent', version: '1.0.0', description: '根据世界资料自主开发专有主题的 Agent', role: 'general',
  plugins: [
    { pluginId: 'agent-loop-runtime' }, { pluginId: 'system-prompt' }, { pluginId: 'world-specific-agent-system-prompt' },
    { pluginId: 'llm' }, { pluginId: 'session' }, { pluginId: 'tools' },
  ],
}
