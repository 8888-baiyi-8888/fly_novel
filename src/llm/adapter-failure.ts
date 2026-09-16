import { LlmBaseError } from './error'
import type { LlmFailure } from './types'

/**
 * 从适配器抛出的值中提取独立、可序列化的失败信息。
 * @param value 分发或迭代适配器流时抛出的值。
 * @returns 与供应商无关的不可变失败信息，用于终止数据块。
 * @internal
 */
export function normalizeLlmFailure(value: unknown): LlmFailure {
  const error = value instanceof Error
    ? value
    : new LlmBaseError(thrownMessage(value), 'UNKNOWN', { cause: value })
  // 跨包实例可能保留自有属性，却不保留类身份。
  // 仅在校验后的失败信息与自有错误码一致时采用这些信息。
  const carried = ownFailureSnapshot(error)
  if (carried !== undefined && carried.code === ownErrorCode(error)) return carried
  return Object.freeze({
    message: errorMessage(error),
    code: llmErrorCode(error),
  })
}

/** 将非 Error 异常转换成文本；转换失败时保留默认摘要。 */
function thrownMessage(value: unknown): string {
  try {
    const message = String(value)
    return message.length > 0 ? message : 'LLM adapter failed'
  } catch (_hostileThrownValue) {
    return 'LLM adapter failed'
  }
}

/** 读取自有数据属性，避免触发 SDK 定义的访问器。 */
function ownFailureSnapshot(error: Error): LlmFailure | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'failure')
    return descriptor !== undefined && 'value' in descriptor
      ? failureSnapshot(descriptor.value)
      : undefined
  } catch (_sdkPropertyTrap) {
    return undefined
  }
}
/** 校验外部失败数据，并复制为独立快照。 */
function failureSnapshot(value: unknown): LlmFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const candidate = value as Partial<LlmFailure>
    const message = candidate.message
    const code = candidate.code
    const status = candidate.status
    const providerRetryAfterMs = candidate.providerRetryAfterMs
    const requestId = candidate.requestId
    const offloadImages = candidate.offloadImages
    if (typeof message !== 'string' || message.length === 0
      || typeof code !== 'string' || code.length === 0
      || (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599))
      || (providerRetryAfterMs !== undefined
        && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0))
      || (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0))
      || (offloadImages !== undefined && (code !== 'IMAGE_OFFLOAD_REQUIRED' || !Number.isSafeInteger(offloadImages) || offloadImages <= 0))) return undefined
    return Object.freeze({
      message,
      code,
      ...status === undefined ? {} : { status },
      ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
      ...requestId === undefined ? {} : { requestId },
      ...offloadImages === undefined ? {} : { offloadImages },
    })
  } catch (_sdkFailureGetter) {
    return undefined
  }
}

/** 读取外部错误的自有 code 数据属性，不执行访问器。 */
function ownErrorCode(error: Error): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch (_sdkPropertyTrap) {
    return undefined
  }
}

/** 读取 SDK 错误摘要；访问器失败时不替换原始错误。 */
function errorMessage(error: Error): string {
  try {
    const message: unknown = error.message
    if (typeof message === 'string' && message.length > 0) return message
  } catch (_sdkMessageGetter) {
    // 使用默认摘要保留可序列化的失败结果。
  }
  return 'LLM adapter failed'
}

/** 仅采用本模块定义的错误码；第三方 SDK 错误码按未知错误处理。 */
function llmErrorCode(error: Error): string {
  return error instanceof LlmBaseError ? error.code : 'UNKNOWN'
}
