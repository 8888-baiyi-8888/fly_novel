import { Session } from './session.js'

/** 在一个 Agent 插件作用域内创建和管理多个内存 Session。 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private closed = false

  /** 创建 Session；省略 ID 时由 Session 生成 UUID，重复 ID 会抛错。 */
  create(id?: string): Session {
    this.assertOpen()
    const session = new Session({ id })
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
  close(id: string): boolean {
    const normalizedId = id.trim()
    const session = this.sessions.get(normalizedId)
    if (!session) return false
    this.sessions.delete(normalizedId)
    session.close()
    return true
  }

  /** 关闭 Manager 持有的所有 Session；重复调用安全。 */
  closeAll(): void {
    if (this.closed) return
    this.closed = true
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Session Manager 已关闭')
  }
}
