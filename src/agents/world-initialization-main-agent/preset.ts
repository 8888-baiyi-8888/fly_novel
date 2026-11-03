import type { AgentPreset } from '../core/contracts/index.js'

/** 世界初始化主 Agent 的基础装配；模型和 Skill 来源由可信应用提供。 */
export const worldInitializationMainAgentPreset: AgentPreset = {
  id: 'world-initialization-main-agent',
  version: '1.0.0',
  description: '世界初始化主 Agent 的基础插件配置',
  role: 'world-initialization-main',
  plugins: [
    { pluginId: 'agent-loop-runtime' },
    { pluginId: 'system-prompt' },
    { pluginId: 'world-initialization-system-prompt' },
    { pluginId: 'llm' },
    { pluginId: 'session' },
    { pluginId: 'tools' },
    { pluginId: 'skills' },
    { pluginId: 'skill-filesystem' },
    { pluginId: 'skill-tool' },
  ],
}
