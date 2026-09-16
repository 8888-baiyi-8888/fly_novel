/** 两种重试模式共用的已解析退避参数。 */
export interface ResolvedRetryBackoff {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

/** 有最大重试次数限制的瞬时错误重试策略。 */
export interface ResolvedNormalRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'normal'
  readonly maxRetries: number
  readonly retryableCodes: readonly string[]
}

/** 不限制次数的重试策略。 */
export interface ResolvedAlwaysRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'always'
}

/** 适配器提供的不可变重试策略声明；运行时不负责执行重试。 */
export type ResolvedRetryPolicy = ResolvedNormalRetryPolicy | ResolvedAlwaysRetryPolicy
