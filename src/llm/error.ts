import type { LlmFailure } from './types'
import type { ProviderRequestId } from './brand'

/**
 * LLM 模块内携带稳定错误码的错误基类。
 *
 * 携带一个 `code`（稳定的、供程序使用的错误码，
 * 例如 `NO_ADAPTER`、`INVALID_ARGS`、`INVARIANT`），
 * 它与供人阅读的 `message` 相互独立。
 *
 * 同时通过标准的 `ErrorOptions` 支持 `cause`（错误原因）链式传递。
 *
 * `name` 默认使用子类构造函数的名称。
 */
export class LlmBaseError extends Error {
  /**
   * 稳定的、可供程序进行路由处理的失败类别
   * （例如 `RATE_LIMIT`）。
   *
   * 应根据该字段进行错误路由，
   * 永远不要通过解析 `message` 来判断错误类型。
   */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}
/** LlmError 接收的供应商失败信息及原始原因。 */
export interface LlmErrorOptions extends ErrorOptions {
  /** 供应商返回的有效 HTTP 状态码。 */
  status?: number
  /** 供应商要求的等待时间，必须是有限正数，单位为毫秒。 */
  providerRetryAfterMs?: number
  /** 供应商返回的非空请求标识。 */
  requestId?: ProviderRequestId
  /** 需额外卸载的最早保留图片数量；仅用于 IMAGE_OFFLOAD_REQUIRED。 */
  offloadImages?: number
}

/**
 * 用于 LLM 相关失败的类型化错误。
 *
 * 继承自 {@link LlmBaseError}，因此 `code` 字符串
 * （例如 `AUTH`、`RATE_LIMIT`、`NO_ADAPTER`）
 * 使用共享的错误分类体系。
 */
export class LlmError extends LlmBaseError {
  /** 与当前 Error 一同保留的可序列化失败信息。 */
  readonly failure: LlmFailure

  /**
   * @param message - 非空的、供人阅读的失败摘要。
   * @param code - 非空且稳定的、与具体 Provider 无关的机器错误码。
   * @param options - 可选的错误原因（cause）以及经过验证的、可序列化的 Provider 相关信息。
   */
  constructor(message: string, code: string, options?: LlmErrorOptions) {
    if (typeof message !== 'string' || message.length === 0)
      throw new Error('LlmError 的 message 必须是非空字符串')

    if (typeof code !== 'string' || code.length === 0)
      throw new Error('LlmError 的 code 必须是非空字符串')

    if (
      options?.status !== undefined
      && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)
    ) {
      throw new Error('LlmError 的 status 必须是 100 到 599 之间的整数')
    }

    if (
      options?.providerRetryAfterMs !== undefined
      && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)
    ) {
      throw new Error('LlmError 的 providerRetryAfterMs 必须是有限的正数')
    }

    if (
      options?.requestId !== undefined
      && (typeof options.requestId !== 'string' || options.requestId.length === 0)
    ) {
      throw new Error('LlmError 的 requestId 必须是非空字符串')
    }

    if (options?.offloadImages !== undefined
      && (code !== 'IMAGE_OFFLOAD_REQUIRED' || !Number.isSafeInteger(options.offloadImages) || options.offloadImages <= 0)) {
      throw new Error('offloadImages 必须是正安全整数，且仅用于 IMAGE_OFFLOAD_REQUIRED')
    }

    super(message, code, options)

    this.name = 'LlmError'

    this.failure = Object.freeze({
      message,
      code,
      ...options?.status === undefined
        ? {}
        : { status: options.status },

      ...options?.providerRetryAfterMs === undefined
        ? {}
        : { providerRetryAfterMs: options.providerRetryAfterMs },

      ...options?.requestId === undefined
        ? {}
        : { requestId: options.requestId },

      ...options?.offloadImages === undefined
        ? {}
        : { offloadImages: options.offloadImages },
    })
  }
}
