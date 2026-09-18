import { brandNumber } from '@fly-novel/util'
import type { Branded, BrandedNumber } from '@fly-novel/util'

/**
 * 为字符串添加编译期品牌标记，不改变其值。
 * @param value - 由目标品牌所属领域接纳的字符串。
 * @returns 带有所需编译期品牌标记的原字符串。
 */
export function brandString<T extends Branded<string>>(value: string | T): T {
  return value as T
}

/** 会话事件的包含式水位序号；尚无事件时为 -1。 */
export type SessionSeqCursor = SessionSeq | -1

/** 会话日志中的间隙位置、前缀长度或读取偏移量，可以等于事件总数。 */
export type SessionLogOffset = BrandedNumber<'SessionLogOffset'>

/** 会话日志中某个已有事件的序号。 */
export type SessionSeq = BrandedNumber<'SessionSeq'>

/** 标识存储中的一个会话及其持久化产物。 */
export type SessionId = Branded<'SessionId'>

/**
 * 为字符串添加 {@link SessionId} 品牌标记。
 * @param id - 原始会话标识字符串。
 * @returns 带有会话标识品牌标记的原字符串。
 */
export function SessionId(id: string): SessionId {
  return brandString<SessionId>(id)
}

/**
 * 将数值接纳为已有会话事件的位置。
 * @param value - 由所属日志操作接纳的非负安全整数。
 * @returns 带有会话事件序号品牌标记的原数值。
 */
export function SessionSeq(value: number): SessionSeq {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionSeq 必须为非负安全整数，实际为 ${String(value)}`)
  }
  return brandNumber<SessionSeq>(value)
}

/**
 * 将数值接纳为会话日志偏移量。
 * @param value - 表示间隙位置或前缀长度的非负安全整数。
 * @returns 带有会话日志偏移量品牌标记的原数值。
 */
export function SessionLogOffset(value: number): SessionLogOffset {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionLogOffset 必须为非负安全整数，实际为 ${String(value)}`)
  }
  return brandNumber<SessionLogOffset>(value)
}
