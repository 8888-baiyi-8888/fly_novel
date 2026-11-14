import type { AgentPreset } from '../core/contracts/index.js'

/** 地图 Agent 的职责与基础服务；地图存储和工具由可信应用装配。 */
export const mapAgentPreset: AgentPreset = {
  id: 'map-agent', version: '1.0.0', description: '开发世界地图与空间资料的 Agent', role: 'general',
  plugins: [
    { pluginId: 'agent-loop-runtime' }, { pluginId: 'system-prompt' }, { pluginId: 'map-agent-system-prompt' },
    { pluginId: 'llm' }, { pluginId: 'session' }, { pluginId: 'tools' },
  ],
}
