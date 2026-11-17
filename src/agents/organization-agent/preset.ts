import type { AgentPreset } from '../core/contracts/index.js'

/** 组织工具与存储由可信应用装配。 */
export const organizationAgentPreset: AgentPreset = {
  id: 'organization-agent', version: '1.0.0', description: '开发世界组织与成员关系的 Agent', role: 'general',
  plugins: [
    { pluginId: 'agent-loop-runtime' }, { pluginId: 'system-prompt' }, { pluginId: 'organization-agent-system-prompt' },
    { pluginId: 'llm' }, { pluginId: 'session' }, { pluginId: 'tools' },
  ],
}
