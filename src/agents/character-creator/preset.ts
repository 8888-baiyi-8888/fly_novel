import type { AgentPreset } from '../core/contracts/index.js'

/** 角色设定创建 Agent 的职责与基础服务；资料工具由可信应用装配。 */
export const characterCreatorPreset: AgentPreset = {
  id: 'character-creator',
  version: '1.0.0',
  description: '创建及修改角色设定的 Agent',
  role: 'general',
  plugins: [
    { pluginId: 'agent-loop-runtime' },
    { pluginId: 'system-prompt' },
    { pluginId: 'character-creator-system-prompt' },
    { pluginId: 'llm' },
    { pluginId: 'session' },
    { pluginId: 'tools' },
  ],
}
