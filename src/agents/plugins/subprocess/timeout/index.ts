/** 超时原因由调用方指定代码，便于区分自身期限和上游取消。 */
export class TimeoutReason extends Error {
  override name = 'TimeoutReason'
  constructor(readonly code: string, readonly timeoutMs: number) {
    super(`${code} after ${timeoutMs}ms`)
  }
}

export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** 合并调用取消和期限；释放后清除定时器，但不终止消费方的工作。 */
export function deadline(upstream: AbortSignal | undefined, timeoutMs: number, code: string): { signal: AbortSignal, [Symbol.dispose](): void } {
  if (timeoutMs <= 0) return { signal: upstream ?? new AbortController().signal, [Symbol.dispose]() {} }
  if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_TIMER_DELAY_MS) throw new Error('deadline timeoutMs 无效')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new TimeoutReason(code, timeoutMs)), timeoutMs)
  return {
    signal: upstream ? AbortSignal.any([upstream, controller.signal]) : controller.signal,
    [Symbol.dispose]() { clearTimeout(timer) },
  }
}

/** 读取匹配代码的期限原因，其他取消返回 undefined。 */
export function timeoutOf(value: AbortSignal | { reason?: unknown }, code?: string): TimeoutReason | undefined {
  const reason: unknown = value.reason
  return reason instanceof TimeoutReason && (code === undefined || reason.code === code) ? reason : undefined
}
