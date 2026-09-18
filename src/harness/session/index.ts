/** 会话公共入口：事件协议、会话实例、消息视图查询及请求头工具。 */

export * from './types/index.ts'

export { Session } from './session.ts'

export type {
  SessionSurface,
  SessionMessageProjection,
  SessionMessageProjectionContext,
  SurfaceFoldReplacement,
  SurfaceFoldResult,
} from './surface/types.ts'
export {
  isSurfaceEligibleType,
  isSurfaceEvent,
  isAppendSurfaceEvent,
  isReplacementSurfaceEvent,
  deriveEventMessage,
} from './surface/message.ts'
export { foldSurface } from './surface/fold.ts'

export { canonicalHeader, headerEquals, foldRequestHeader } from './request-header.ts'
