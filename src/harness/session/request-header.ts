/**
 * 根据完整的 request/header 事件重建请求头，并比较规范化后的请求配置。
 */

import { callConfigEquals } from '@fly-novel/llm'
import type { ToolSchema } from '@fly-novel/llm'
import type { EpochHeader, SessionEvent } from './types/index.ts'

/**
 * 规范化请求头：省略空工具列表及未生效的适配器默认值标记。
 * @param header - 待规范化的请求头，不修改输入。
 * @returns 规范化后的请求头。
 */
export function canonicalHeader(header: EpochHeader): EpochHeader {
  const adapterDefaults = header.adapterDefaults
  return {
    config: header.config,
    ...adapterDefaults?.reasoningEffort === true || adapterDefaults?.maxTokens === true
      ? { adapterDefaults }
      : {},
    ...header.tools !== undefined && header.tools.length > 0 ? { tools: header.tools } : {},
  }
}

/**
 * 比较经同一路径组装的工具模式的 JSON 表示。
 */
function sameSchema(a: ToolSchema, b: ToolSchema): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 逐字段比较规范化的请求头，工具模式按顺序比较。
 * @param a - 第一个规范化请求头。
 * @param b - 第二个规范化请求头。
 * @returns 配置、适配器默认值及工具模式全部一致时返回 true。
 */
export function headerEquals(a: EpochHeader, b: EpochHeader): boolean {
  if (
    !callConfigEquals(a.config, b.config)
    || a.adapterDefaults?.reasoningEffort !== b.adapterDefaults?.reasoningEffort
    || a.adapterDefaults?.maxTokens !== b.adapterDefaults?.maxTokens
  ) return false
  const at = a.tools ?? []
  const bt = b.tools ?? []
  return at.length === bt.length && at.every((tool, i) => sameSchema(tool, bt[i] as ToolSchema))
}

/**
 * 按日志顺序读取请求头事件，跳过其他事件，得到最新生效的请求头。
 * @param events - 按日志顺序排列的会话事件。
 * @param from - 可选的已有折叠结果，用于继续增量处理。
 * @returns 最新的规范化请求头；尚无请求头时返回 undefined。
 */
export function foldRequestHeader(events: readonly SessionEvent[], from?: EpochHeader): EpochHeader | undefined {
  let state = from
  for (const event of events) {
    if (event.type === 'request/header') state = canonicalHeader(event.data.header)
  }
  return state
}
