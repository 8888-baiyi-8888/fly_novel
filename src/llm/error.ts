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


/**
 * 将捕获到的异常值及其完整的 `cause`（原因）链、AggregateError（聚合错误）
 * 中包含的成员一起渲染出来。
 *
 * 这样，像 undici 的 `TypeError: fetch failed` 这类传输层包装错误，
 * 就能够展示其底层真正的失败原因，而不是将其掩盖。
 *
 * 普通的结构化失败对象会渲染其自身由数据提供的 `message`。
 *
 * 此函数仅用于诊断信息展示（例如消息、通知、日志）——
 * 永远不要解析该函数返回的字符串来进行程序逻辑判断；
 * 错误路由应基于 {@link HarnessError.code}。
 *
 * @param value - 捕获到的值（catch 子句中的类型为 `unknown`）。
 *
 * @returns 最外层的错误消息放在最前面，每一级 cause 使用 `: ` 追加。
 *          如果 cause 的消息与包装层消息完全相同，则跳过该 cause，
 *          避免重复。
 *          AggregateError 中的成员会放在方括号 `[]` 中，
 *          并使用 `; ` 连接。
 */
export function errorChain(value: unknown): string {
  // 记录当前正在递归处理的路径（退出递归时会删除对应条目），
  // 因此只有真正出现循环引用时才会被标记。
  // 如果只是多个节点共享同一个 cause（菱形共享结构），
  // 该 cause 仍然能够被完整渲染。
  const path = new Set<unknown>()

  const render = (current: unknown): string => {
    if (path.has(current)) return '<循环的 cause>'

    path.add(current)

    try {
      if (!(current instanceof Error)) {
        if (typeof current === 'object' && current !== null) {
          const descriptor = Object.getOwnPropertyDescriptor(current, 'message')

          if (
            descriptor !== undefined &&
            'value' in descriptor &&
            typeof descriptor.value === 'string'
          ) {
            return descriptor.value
          }
        }

        return String(current)
      }

      const message = current.message === ''
        ? current.name
        : current.message

      const members =
        current instanceof AggregateError && current.errors.length > 0
          ? ` [${current.errors.map(render).join('; ')}]`
          : ''

      const causeText =
        current.cause === undefined || current.cause === null
          ? ''
          : render(current.cause)

      // 类似下面这样的包装：
      //
      // `new HarnessError(String(value), code, { cause: value })`
      //
      // 包装层的 message 可能会与 cause 的内容完全重复；
      // 如果再次渲染 cause，只会产生没有意义的重复信息。
      const cause =
        causeText === '' || causeText === message
          ? ''
          : `: ${causeText}`

      return `${message}${members}${cause}`
    } catch {
      // 这里只会处理一些“恶意”或异常的类型转换 / 属性访问情况，
      // 例如：
      //
      // - 非 Error 对象具有会抛出异常的 toString
      // - 非 Error 对象具有会抛出异常的 Symbol.toPrimitive
      // - Error 子类中的 message / name / cause / errors getter 会抛出异常
      //
      // 由于该渲染函数用于 UI 通知和日志，
      // 因此绝不能让异常继续向外传播。
      //
      // 内层递归调用会自行捕获自己的异常，
      // 所以只会让当前这个异常节点退化为无法渲染，
      // 而不会导致整个错误链都无法显示。
      return '<无法渲染的值>'
    } finally {
      path.delete(current)
    }
  }

  return render(value)
}