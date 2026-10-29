import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionAccess, SessionHandle, SessionHeader } from './handle.js'

export type { SessionAccess, SessionHandle, SessionHeader } from './handle.js'

/** 不读取事件正文的会话元数据。 */
export interface SessionPersistenceSnapshot {
  readonly header: SessionHeader
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPersistence: SessionPersistence
  }
}

/** 持久化服务契约；具体存储后端提供实现。 */
export abstract class SessionPersistence extends Service {
  constructor(ctx: Context) { super(ctx, 'sessionPersistence') }

  /** 创建新会话并返回写句柄；ID 已存在时拒绝。 */
  abstract create(header: SessionHeader): Promise<SessionHandle>
  /** 按 ID 打开已有会话；不存在时拒绝。 */
  abstract open(id: string, access: SessionAccess): Promise<SessionHandle>
  /** 等待当前写句柄的待处理写入达到后端提供的持久化边界。 */
  abstract flush(): Promise<void>
  /** 取得会话元数据；不存在时返回 undefined。 */
  abstract stat(id: string): Promise<SessionPersistenceSnapshot | undefined>
  /** 列出存储中的会话元数据。 */
  abstract list(): Promise<readonly SessionPersistenceSnapshot[]>
}
