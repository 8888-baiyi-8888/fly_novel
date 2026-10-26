import type { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from './system-prompt.js'

export type SystemPromptPluginConfig = Record<string, never>

declare module '@deepseek-ai/cordis' {
  interface Context {
    systemPrompt: SystemPrompt
  }
}

/** 为当前 Agent Context 提供独立的 SystemPrompt 服务。 */
export const systemPromptPlugin = Object.assign(function systemPromptPlugin(
  ctx: Context,
  _config: SystemPromptPluginConfig = {},
): void {
  const systemPrompt = new SystemPrompt()
  ctx.provide('systemPrompt', systemPrompt)
  ctx.effect(() => () => systemPrompt.dispose())
}, { provide: 'systemPrompt' })
