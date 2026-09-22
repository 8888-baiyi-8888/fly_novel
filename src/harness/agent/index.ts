export * from './types'
export * from './runtime-types'
export * from './dispatch'
import { AgentRegistry } from './registry'
export * from './registry'
declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentRegistry
  }
}