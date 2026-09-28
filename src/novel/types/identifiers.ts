import type { Branded } from '@fly-novel/util'

/** 书级唯一标识，对应 BookConfig.bookId。 */
export type BookId = Branded<'BookId'>

/** 伏笔账本条目唯一标识（如 "H007"），对应 HookRecord.hookId。 */
export type HookId = Branded<'HookId'>

/** 叙事线唯一标识（旧称 timelineId，与之同义），对应 Thread.threadId。 */
export type ThreadId = Branded<'ThreadId'>

/** 叙事线事件链单元唯一标识（如 "E-M01"），对应 ThreadEvent.eventId。 */
export type EventId = Branded<'EventId'>

/** 时态事实唯一标识，对应 Fact.factId。 */
export type FactId = Branded<'FactId'>

/** 角色名称标识，用于角色卡、出场名单与 knownBy 中的角色引用。 */
export type CharacterName = Branded<'CharacterName'>
