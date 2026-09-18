import type { Message } from '@fly-novel/llm'
import type { SessionEvent, SessionSeq, SurfaceEvent, SurfaceOp } from '../types/index.ts'

/** 可生成消息的事件联合类型所对应的运行时集合。 */
const SURFACE_EVENT_TYPES = new Set<string>([
  'system/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * 判断事件类型是否可进入模型可见的消息视图。
 * @param type - 待检查的事件类型。
 * @returns 属于四种消息事件类型之一时返回 true。
 */
export function isSurfaceEligibleType(type: string): boolean {
  return SURFACE_EVENT_TYPES.has(type)
}

/**
 * 将事件收窄为携带必要标记、可进入消息视图的事件。
 * @param event - 待检查的事件。
 * @returns 类型与标记均表明它是消息视图事件时返回 true。
 */
export function isSurfaceEvent(event: SessionEvent): event is SurfaceEvent {
  if (!SURFACE_EVENT_TYPES.has(event.type)) return false
  const candidate: { surfaceOp?: unknown } = event
  return candidate.surfaceOp !== undefined
}

/**
 * 将事件收窄为以追加方式进入消息视图的事件：它在自身日志位置进入视图，而非替换副本。
 * 模型可见视图会遮蔽被替换的范围，因此不适合作为用户会话记录的来源，否则替换会抹去用户已看到的内容。
 * 以追加方式进入视图的事件是用户会话记录的持久化来源；替换副本仅供模型使用。
 * @param event - 待检查的事件。
 * @returns 事件追加到消息视图末尾时返回 true。
 */
export function isAppendSurfaceEvent(
  event: SessionEvent,
): event is SurfaceEvent & { surfaceOp: 'append' } {
  return isSurfaceEvent(event) && event.surfaceOp === 'append'
}

/**
 * 将事件收窄为消息视图替换事件：它遮蔽已有范围，而非追加到末尾。
 * 与 {@link isAppendSurfaceEvent} 分别对应 {@link SurfaceOp} 的两种变体。
 * @param event - 待检查的事件。
 * @returns 事件替换了消息视图中的范围时返回 true。
 */
export function isReplacementSurfaceEvent(
  event: SessionEvent,
): event is SurfaceEvent & { surfaceOp: Extract<SurfaceOp, { op: 'replace' }> } {
  return isSurfaceEvent(event) && event.surfaceOp !== 'append'
}

/**
 * 将单个事件投影为对应的 LLM 消息；非消息视图事件或仅记录用量的空内容 assistant/message 返回 null。
 * 重建模型输入时，调用方应传入 {@link foldSurface} 对同一日志前缀生成的 projectedMessages；未提供时读取原始事件内容。
 * Session 实例方法应用实时投影。消息不可变，内容未变时保留其持久标识。
 * @param event - 待投影的事件。
 * @param projectedMessages - 对同一日志前缀折叠消息视图得到的消息投影。
 * @returns 派生消息；事件不生成消息时返回 null。
 */
export function deriveEventMessage(
  event: SessionEvent,
  projectedMessages?: ReadonlyMap<SessionSeq, Message>,
): Message | null {
  const projected = projectedMessages?.get(event.seq)
  if (projected !== undefined) return projected
  // 有意不穷尽所有分支：只有消息事件会派生历史。
  // 轮次或步骤边界、失败尝试和错误属于追踪或重放
  // 数据。
  switch (event.type) {
    // 用户输入和注入上下文原样投影，内容包装由生产者负责。
    case 'user/message': {
      return event.data
    }
    // 空内容消息不生成协议消息。对于
    // system/message，节点记录“无系统提示词”并保留
    // 视图位置；对于 assistant/message，事件仅用于记录
    // 达到 max-tokens 上限的步骤用量，不应向供应商会话记录
    // 注入没有内容的 assistant 轮次。
    case 'system/message':
    case 'assistant/message': {
      if (event.data.message.content.length === 0) return null
      return event.data.message
    }
    case 'tool/result': {
      return event.data.message
    }
    default:
      // 非消息视图事件（边界、尝试、仅日志记录）不生成
      // 消息。联合类型可通过声明合并扩展，因此这里不使用 assertNever。
      return null
  }
}
