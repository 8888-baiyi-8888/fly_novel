import type { SessionEvent, SessionSeq, SurfaceOp } from '../types/index.ts'
import { KNOWN_SESSION_EVENT_TYPES } from '../types/known-events.ts'
import { isSurfaceEligibleType } from './message.ts'

/** 判断运行时值是否为非负安全整数事件序号。 */
function isEventSeq(value: unknown): value is SessionSeq {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0)
}

/** 判断运行时值是否严格符合位置替换结构。 */
function isReplaceOp(value: object): value is Extract<SurfaceOp, { op: 'replace' }> {
  const op = value as Record<string, unknown>
  return Object.keys(op).length === 3
    && Object.hasOwn(op, 'op')
    && Object.hasOwn(op, 'startSeq')
    && Object.hasOwn(op, 'endSeq')
    && op['op'] === 'replace'
    && isEventSeq(op['startSeq'])
    && isEventSeq(op['endSeq'])
}

/** 校验事件自身是否可进入消息视图，并返回其操作。 */
function surfaceOpOf(event: SessionEvent): SurfaceOp | undefined {
  const raw: { surfaceOp?: unknown; sourceEventSeqs?: unknown } = event
  if (!isSurfaceEligibleType(event.type)) {
    // 未知但可忽略的记录保留不透明元数据，不影响历史。
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true) return
    if (raw.surfaceOp !== undefined) {
      throw new Error(`会话事件 "${event.type}" 不属于消息视图事件，不能携带 surfaceOp`)
    }
    if (raw.sourceEventSeqs !== undefined) {
      throw new Error(`会话事件 "${event.type}" 不属于消息视图事件，不能携带 sourceEventSeqs`)
    }
    return
  }
  const op = raw.surfaceOp
  if (op === undefined) {
    throw new Error(`会话事件 "${event.type}" 属于消息视图事件，必须携带 surfaceOp 标记`)
  }
  if (op === 'append') return op
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    throw new Error(`会话事件 "${event.type}" 的 surfaceOp 无效`)
  }
  if (!isReplaceOp(op)) {
    throw new Error(`会话事件 "${event.type}" 的替换操作 surfaceOp 无效`)
  }
  return op
}

/** 根据此前日志条目和替换范围校验引用的源事件序号。 */
export function assertSourceEventReferences(
  event: SessionEvent,
  shadowedSeqs: readonly SessionSeq[],
): void {
  const raw: unknown = event.sourceEventSeqs
  if (event.type === 'assistant/message' && raw !== undefined) {
    throw new Error('assistant/message 已内嵌源响应流，不能携带 sourceEventSeqs')
  }
  const sources = new Set<SessionSeq>()
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      throw new Error(`序号 ${event.seq} 处事件的 sourceEventSeqs 如存在则必须为数组`)
    }
    if (raw.length === 0) {
      throw new Error('sourceEventSeqs 不能为空')
    }
    let nonEarlierSource: SessionSeq | undefined
    for (const source of raw) {
      if (!isEventSeq(source)) {
        throw new Error(`会话事件 "${event.type}" 的 sourceEventSeqs 必须是无空位的非负安全整数数组`)
      }
      sources.add(source)
      if (nonEarlierSource === undefined && source >= event.seq) nonEarlierSource = source
    }
    if (sources.size !== raw.length) {
      throw new Error('sourceEventSeqs 不能包含重复值')
    }
    if (nonEarlierSource !== undefined) {
      throw new Error(`sourceEventSeqs 必须引用更早的事件：${nonEarlierSource} >= 当前序号 ${event.seq}`)
    }
  }
  const missing = shadowedSeqs.filter(seq => !sources.has(seq))
  if (missing.length > 0) {
    throw new Error(`消息视图替换：sourceEventSeqs 必须包含所有被遮蔽的节点；缺少 ${missing.join(', ')}`)
  }
}

/**
 * 校验单个事件的消息视图元数据，不检查它是否属于某份日志或视图。
 * @param event - 要检查其标记和源序号的事件。
 * 未知但可忽略的记录保留不透明元数据，且不改变消息视图。
 * @returns 已校验的操作；仅日志事件或未知但可忽略的事件返回 undefined。
 * @throws 元数据违反事件自身的资格、标记或源序号规则时抛错。
 */
export function validateSurfaceMetadata(event: SessionEvent): SurfaceOp | undefined {
  const op = surfaceOpOf(event)
  if (op !== undefined && op !== 'append'
    && (op.startSeq >= event.seq || op.endSeq >= event.seq)) {
    throw new Error(`序号 ${event.seq} 处的消息视图替换：startSeq 和 endSeq 必须引用更早的事件`)
  }
  if (op !== undefined) assertSourceEventReferences(event, [])
  return op
}
