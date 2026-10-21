import type { AgentParameters, AgentRole } from './agent.js'

export interface PresetPluginBinding {
  pluginId: string
  config?: unknown
}

export interface AgentPreset {
  id: string
  version: string
  description?: string
  role: AgentRole
  defaultParameters?: AgentParameters
  plugins: PresetPluginBinding[]
}

export interface CreateAgentOptions {
  id: string
  name?: string
  presetId: string
  parameters?: AgentParameters
  pluginConfigs?: Record<string, unknown>
}
