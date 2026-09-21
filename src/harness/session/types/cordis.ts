import type { Session } from '../session.ts'
import type { SessionEvent } from './index.ts'
import type { Scoped } from '../../scope/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 会话成功追加事件后发出的通知，通过作用域载体筛选监听器。
     * @param session 日志发生追加的会话
     * @param event 已提交到日志的事件
     */
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
  }
}
