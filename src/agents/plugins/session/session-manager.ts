import { Session } from './session.js'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from './types.js'

/** 在一个 Agent 插件作用域内创建和管理多个内存 Session。 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private closed = false
  private readonly closing = new Map<string, Promise<boolean>>()
  private closingAll?: Promise<void>
  constructor(private readonly context?: Context) {}

  /** 创建 Session；省略 ID 时由 Session 生成 UUID，重复 ID 会抛错。 */
  create(id?: string, options: { seed?: readonly SessionEvent[]; createdAt?: Date } = {}): Session {
    this.assertOpen()
    const session = new Session({ id, ...options }, (owner, event) => this.context?.emit('session/event', owner, event))
    if (this.sessions.has(session.id)) {
      throw new Error(`Session "${session.id}" 已存在`)
    }
    this.sessions.set(session.id, session)
    return session
  }

  /** 查找当前 Manager 持有的 Session；不存在时返回 undefined。 */
  get(id: string): Session | undefined {
    return this.sessions.get(id.trim())
  }

  /** 按创建顺序返回当前 Session 的新数组。 */
  list(): Session[] {
    return [...this.sessions.values()]
  }

  /** 关闭并移除指定 Session；不存在时返回 false。 */
  async flush(session: Session): Promise<void> {
    if (this.sessions.get(session.id) !== session) throw new Error('Session 不属于当前 Manager')
    await this.context?.parallel('session/flush', session)
  }

  close(id: string): Promise<boolean> {
    const normalizedId = id.trim()
    const existing = this.closing.get(normalizedId)
    if (existing) return existing
    const session = this.sessions.get(normalizedId)
    if (!session) return Promise.resolve(false)
    session.beginClose()
    const operation = (async () => {
      try {
        await this.flush(session)
        await this.context?.parallel('session/disposed', session)
        this.sessions.delete(normalizedId)
        session.close()
        return true
      } catch (error) {
        session.cancelClose()
        throw error
      } finally { this.closing.delete(normalizedId) }
    })()
    this.closing.set(normalizedId, operation)
    return operation
  }

  /** 关闭 Manager 持有的所有 Session；重复调用安全。 */
  closeAll(): Promise<void> {
    if (this.closingAll) return this.closingAll
    if (this.closed) return Promise.resolve()
    this.closed = true
    this.closingAll = (async () => {
      try {
        const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.close(id)))
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) { this.closed = false; throw new AggregateError(errors, '关闭 Session 失败') }
      } finally { this.closingAll = undefined }
    })()
    return this.closingAll
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Session Manager 已关闭')
  }
}
