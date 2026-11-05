import type { AgentPreset } from '../core/contracts/index.js'

/** 通过可信配置装配执行通用任务的 Agent。 */
export const genericSubagentPreset: AgentPreset = {
  id: 'generic-subagent',
  version: '1.0.0',
  description: '通用子 Agent 的基础插件配置',
  role: 'general',
  plugins: [
    { pluginId: 'agent-loop-runtime' },
    { pluginId: 'system-prompt' },
    { pluginId: 'generic-subagent-system-prompt' },
    { pluginId: 'llm' },
    { pluginId: 'session' },
  ],
}
