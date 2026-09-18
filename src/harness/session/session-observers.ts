import type { Context } from '@deepseek-ai/cordis'
import type { Scoped } from '../scope/index.ts'
import type { Session } from './session.ts'
import type { SessionId } from './types/index.ts'

/** 会话观察者回调；返回的 Promise 由通知流程隔离处理。 */
export type SessionCallback = (...args: unknown[]) => unknown

/** 单个会话存储条目的可变生命周期状态。 */
export interface SessionEntry {
  readonly id: SessionId
  readonly session: Session
  readonly carrier: Scoped<Session>
  readonly emitCtx: Context
  announced: boolean
  announcing: boolean
  appending: boolean
  detachRequested: boolean
  detach(): void
}

/** 追加流程使用的存储关联；仅供模块内部使用，不暴露到 Session 公共接口。 */
export const attachments = new WeakMap<Session, SessionEntry>()

/** 获取观察者快照，并执行 Cordis 内部的分发检查。 */
export function collectSessionCallbacks(ctx: Context, args: unknown[]): SessionCallback[] {
  return [...ctx.events.dispatch('emit', args)] as SessionCallback[]
}

/** 逐个调用观察者快照，分别隔离同步异常与异步拒绝。 */
export function invokeContainedSessionObservers(
  ctx: Context,
  name: 'session/event' | 'session/disposed',
  id: SessionId,
  args: unknown[],
  callbacks: SessionCallback[],
): void {
  for (const callback of callbacks) {
    try {
      const returned: unknown = callback(...args)
      void Promise.resolve(returned).catch((error: unknown) => {
        ctx.logger.warn(`会话 "${id}"：${name} 监听器异步失败：${String(error)}`)
      })
    } catch (error: unknown) {
      ctx.logger.warn(`会话 "${id}"：${name} 监听器抛出异常：${String(error)}`)
    }
  }
}
