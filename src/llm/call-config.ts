import type { ReasoningEffortId } from './brand'

/** 模型路由与采样配置，各字段对应 GenerateOptions 的同名请求参数。 */
export interface LlmCallConfig{
    provider: string  // 模型供应商 / Provider 路由
    model: string  // 使用的模型
    reasoningEffort?: ReasoningEffortId  // 推理强度
    temperature?: number  // 采样温度
    maxTokens?: number  // 最大生成 Token数
    stop?: string[]  // 停止序列
}

/**
 * 按字段比较调用配置，stop 按元素顺序比较。
 * @param a 第一份配置。
 * @param b 第二份配置。
 * @returns 所有字段是否一致。
 */
export function callConfigEquals(a: LlmCallConfig, b: LlmCallConfig): boolean {
  if (
    a.provider !== b.provider
    || a.model !== b.model
    || a.reasoningEffort !== b.reasoningEffort
    || a.temperature !== b.temperature
    || a.maxTokens !== b.maxTokens
  ) return false
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i])
}
