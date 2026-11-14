import type { AgentPreset } from '../core/contracts/index.js'

/** 世界基础信息 Agent 的职责与基础服务；资料工具由可信应用装配。 */
export const worldBasicsPreset: AgentPreset = {
  id: 'world-basics',
  version: '1.0.0',
  description: '开发世界基础信息的 Agent',
  role: 'general',
  plugins: [
    { pluginId: 'agent-loop-runtime' },
    { pluginId: 'system-prompt' },
    { pluginId: 'world-basics-system-prompt' },
    { pluginId: 'llm' },
    { pluginId: 'session' },
    { pluginId: 'tools' },
  ],
}
