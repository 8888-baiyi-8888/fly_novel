import type { AgentPreset } from '../core/contracts/index.js'

/** 规划存储和工具由可信应用装配。 */
export const worldDevelopmentAgentPreset: AgentPreset = {
  id: 'world-development-agent', version: '1.0.0', description: '开发世界宏观、故事线与人物成长规划的 Agent', role: 'general',
  plugins: [
    { pluginId: 'agent-loop-runtime' }, { pluginId: 'system-prompt' }, { pluginId: 'world-development-agent-system-prompt' },
    { pluginId: 'llm' }, { pluginId: 'session' }, { pluginId: 'tools' },
  ],
}
