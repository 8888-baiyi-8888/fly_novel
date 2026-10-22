import { deepFreeze } from '@fly-novel/util'
import { randomUUID } from 'node:crypto'
import type { SessionEvent, SessionEventMap, SessionEventType } from './types.js'
export type { SessionEvent, SessionEventMap, SessionEventType } from './types.js'

export interface SessionOptions {
  /** 调用方分配的会话标识；未提供时生成随机 UUID。 */
  id?: string
  /** 会话创建时间；未提供时使用当前时间。 */
  createdAt?: Date
}

/** 进程内只追加会话事件日志。 */
export class Session {
  readonly id: string
  readonly createdAt: Date
  private readonly events: SessionEvent[] = []
  private closed = false

  constructor(options: SessionOptions) {
    const id = options.id?.trim() ?? randomUUID()
    if (!id) throw new Error('Session ID 不能为空')
    const createdAt = options.createdAt ?? new Date()
    if (Number.isNaN(createdAt.getTime())) throw new Error('Session 创建时间无效')

    this.id = id
    this.createdAt = new Date(createdAt)
  }

  /** 追加事件快照，并返回其从零开始的顺序索引。 */
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T]): SessionEvent<T> {
    this.assertOpen()
    if (typeof type !== 'string' || !type.trim()) throw new Error('Session 事件类型不能为空')
    const event = deepFreeze(structuredClone({
      type,
      seq: this.events.length,
      time: Date.now(),
      data,
    })) as SessionEvent<T>
    this.events.push(event as SessionEvent)
    return event
  }

  /** 按追加顺序读取事件；afterIndex 为排他游标，limit 限制返回数量。 */
  read(options: { afterIndex?: number; limit?: number } = {}): readonly SessionEvent[] {
    this.assertOpen()
    const { afterIndex = -1, limit = Number.POSITIVE_INFINITY } = options
    if (!Number.isInteger(afterIndex) || afterIndex < -1) {
      throw new Error('Session 历史游标必须是大于等于 -1 的整数')
    }
    if (!(limit === Number.POSITIVE_INFINITY || (Number.isInteger(limit) && limit >= 0))) {
      throw new Error('Session 历史读取数量必须是非负整数')
    }
    return this.events.slice(afterIndex + 1, afterIndex + 1 + limit)
  }

  /** 返回当前事件数。 */
  get size(): number {
    return this.events.length
  }

  /** 关闭 Session 并释放内存中的事件；重复关闭安全。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.events.length = 0
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`Session "${this.id}" 已关闭`)
  }
}
