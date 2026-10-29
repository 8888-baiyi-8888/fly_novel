import type { SessionEvent } from '@fly-novel/session'

/** 保存会话的基本身份；存储格式版本由后端定义。 */
export interface SessionHeader {
  readonly id: string
  readonly createdAt: string
  /** 是否确保每次工具执行前持久化其开始记录。 */
  readonly toolCallCheckpoint?: boolean
}

export type SessionAccess = 'read' | 'write'

/** 单个会话的持久化句柄；关闭后除重复 close 外的方法均拒绝调用。 */
export interface SessionHandle {
  readonly id: string
  readonly header: SessionHeader
  readonly access: SessionAccess
  /** 从 offset 开始读取最多 length 条事件；默认读取全部剩余事件。 */
  read(offset?: number, length?: number): Promise<{ readonly events: readonly SessionEvent[] }>
  /** 追加连续事件；只读句柄或不连续序号应被拒绝。 */
  append(events: readonly SessionEvent[]): Promise<void>
  /** 等待已接受写入达到后端提供的持久化边界。 */
  flush(): Promise<void>
  /** 刷新待处理写入并释放资源；可重复调用。 */
  close(): Promise<void>
}
