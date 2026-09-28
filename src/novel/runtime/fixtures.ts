import type { BookConfig } from '../types/book-config.ts'
import type { CharacterCard, CharacterState } from '../types/character.ts'
import type { BookId, CharacterName, EventId, FactId, HookId, ThreadId } from '../types/identifiers.ts'
import type { Fact } from '../types/fact.ts'
import type { HookRecord } from '../types/hook.ts'
import type { Thread, ThreadEvent } from '../types/thread.ts'

/**
 * §7.7 实例（章节级文档 §4.4/§7.7 常用 fixture）：作为 FakeBookRuntime 的默认初始状态，
 * 也是章节流测试的确定性数据源。字段值取自文档示例（H007 撕不掉的离婚协议、H011 老陈的那瓶酒、
 * H014 五年前的雨夜、H021 江辰的第二次电话、H023 苏晴的体检单；tl-main-share 主线、tl-flashback-rain 闪回线）。
 */

export const H007 = 'H007' as HookId
export const H011 = 'H011' as HookId
export const H014 = 'H014' as HookId
export const H021 = 'H021' as HookId
export const H023 = 'H023' as HookId

export const TL_MAIN = 'tl-main-share' as ThreadId
export const TL_FLASHBACK_RAIN = 'tl-flashback-rain' as ThreadId

export const BOOK_CONFIG: BookConfig = {
  bookId: 'book-fake-001' as BookId,
  title: '龙王赘婿',
  genre: 'dushi',
  platform: 'fanqie',
  targetChapters: 100,
  chapterWordCount: 2500,
  language: 'zh-CN',
  chapterReviewMode: 'auto',
  maxHookRetries: 2,
  createdAt: '2026-09-20',
  updatedAt: '2026-09-20',
}

export const HOOK_LEDGER: Readonly<Record<HookId, HookRecord>> = {
  [H007]: {
    hookId: H007, startChapter: 2, type: '物件', status: 'progressing', lastAdvancedChapter: 19, advancedCount: 1,
    expectedPayoff: '江家用协议做文章时，第三条对赌条款反噬江氏分公司', payoffTiming: 'mid-arc',
    coreHook: true, notes: '四道折痕 / 抽屉最底层',
  },
  [H011]: {
    hookId: H011, startChapter: 5, type: '信息差', status: 'open', lastAdvancedChapter: 10, advancedCount: 1,
    expectedPayoff: '老陈亲口说出"殿主"称呼', payoffTiming: 'slow-burn', notes: '老陈的那瓶酒',
  },
  [H014]: {
    hookId: H014, startChapter: 6, type: '秘密', status: 'open', lastAdvancedChapter: 10, advancedCount: 1,
    expectedPayoff: '雨夜真相（叶凡进屋之后）', payoffTiming: 'endgame', notes: '五年前的雨夜',
  },
  [H021]: {
    hookId: H021, startChapter: 16, type: '关系', status: 'open', lastAdvancedChapter: 18, advancedCount: 1,
    expectedPayoff: '江辰的第二次电话内容', payoffTiming: 'near-term',
  },
  [H023]: {
    hookId: H023, startChapter: 8, type: '秘密', status: 'deferred', lastAdvancedChapter: 10, advancedCount: 1,
    expectedPayoff: '苏晴的体检单', payoffTiming: 'near-term',
  },
}

/** 伏笔归属叙事线（canReach 判定用；真实归属表由小说流维护）。 */
export const HOOK_TO_THREAD: Readonly<Record<HookId, ThreadId>> = {
  [H007]: TL_MAIN,
  [H011]: TL_MAIN,
  [H014]: TL_FLASHBACK_RAIN,
  [H021]: TL_MAIN,
  [H023]: TL_MAIN,
}

const E_M07: ThreadEvent = {
  eventId: 'E-M07' as EventId, summary: '对赌条款反噬江氏，收束 H007', chapter: 21, prerequisiteEventIds: [], status: 'pending',
}
const E_F01: ThreadEvent = {
  eventId: 'E-F01' as EventId, summary: '叶凡进屋之后（揭示雨夜真相的前提）', chapter: null, prerequisiteEventIds: [], status: 'pending',
}

export const THREADS: readonly Thread[] = [
  {
    threadId: TL_MAIN, kind: 'main', title: '江氏主线', status: 'active', priority: 10,
    syncPoint: 21, speed: 1, eventChain: [E_M07], characters: ['叶凡' as CharacterName, '苏晴' as CharacterName, '江辰' as CharacterName],
  },
  {
    threadId: TL_FLASHBACK_RAIN, kind: 'flashback', title: '五年前的雨夜', status: 'dormant', priority: 3,
    syncPoint: 3, speed: 0.3, eventChain: [E_F01], characters: ['叶凡' as CharacterName, '苏晴' as CharacterName],
  },
]

export const FACTS: readonly Fact[] = [
  {
    factId: 'F001' as FactId, subject: '老陈', subjectType: 'character', predicate: '知道称呼', object: '殿主',
    validFromChapter: 10, validUntilChapter: null, sourceChapter: 10, knownBy: ['老陈' as CharacterName, '苏晴' as CharacterName], status: 'active',
  },
]

export const CHARACTERS: readonly CharacterCard[] = [
  {
    name: '叶凡' as CharacterName, tier: 'S', archetype: '隐忍赘婿', aliases: [], traits: ['沉默', '果决'], speechStyle: '短句',
    goals: ['护住苏晴'], fears: ['苏晴知道真相'], secret: '龙王身份', knowledgeBoundary: ['苏晴的体检结果'],
    relationships: [{ target: '苏晴' as CharacterName, type: '夫妻', desc: '隐忍守护' }],
  },
  {
    name: '苏晴' as CharacterName, tier: 'S', archetype: '家业继承人', aliases: [], traits: ['敏锐', '重情'], speechStyle: '克制',
    goals: ['查清协议疑点'], fears: ['协议被江家利用'], secret: '藏有协议副本', knowledgeBoundary: ['叶凡的龙王身份'],
    relationships: [{ target: '叶凡' as CharacterName, type: '夫妻', desc: '渐生信任' }],
  },
  {
    name: '江辰' as CharacterName, tier: 'A', archetype: '世家子弟', aliases: [], traits: ['傲慢', '胆怯'], speechStyle: '官腔',
    goals: ['吞并分公司'], fears: ['对赌条款反噬'], secret: '电话内容', knowledgeBoundary: [],
    relationships: [{ target: '叶凡' as CharacterName, type: '对立', desc: '轻视' }],
  },
  {
    name: '老陈' as CharacterName, tier: 'B', archetype: '旧部掌柜', aliases: [], traits: ['忠厚'], speechStyle: '老派',
    goals: [], fears: [], secret: '知道殿主称呼', knowledgeBoundary: [], relationships: [],
  },
]

export const CHARACTER_STATES: Readonly<Record<CharacterName, CharacterState>> = {
  ['叶凡' as CharacterName]: { name: '叶凡' as CharacterName, location: '江氏会议室', goal: '按协议收束 H007', emotion: '平静', knows: [], suspects: [], inventory: [], bonds: { 苏晴: 60 } },
  ['苏晴' as CharacterName]: { name: '苏晴' as CharacterName, location: '江氏会议室', goal: '列席观察', emotion: '警觉', knows: ['老陈 知道称呼 殿主'], suspects: ['协议与我有关'], inventory: [], bonds: { 叶凡: 40 } },
  ['江辰' as CharacterName]: { name: '江辰' as CharacterName, location: '江氏会议室', goal: '促成协议生效', emotion: '得意', knows: [], suspects: [], inventory: [], bonds: { 叶凡: -30 } },
  ['老陈' as CharacterName]: { name: '老陈' as CharacterName, location: '江氏停车场', goal: '送酒', emotion: '平静', knows: ['老陈 知道称呼 殿主'], suspects: [], inventory: ['那瓶酒'], bonds: {} },
}

/** FakeBookRuntime 构造选项：全部可选，缺省取上方 §7.7 默认 fixture。 */
export interface FakeBookRuntimeOptions {
  readonly config?: BookConfig
  readonly ledger?: Readonly<Record<HookId, HookRecord>>
  readonly threads?: readonly Thread[]
  readonly facts?: readonly Fact[]
  readonly characters?: readonly CharacterCard[]
  readonly characterStates?: Readonly<Record<CharacterName, CharacterState>>
  readonly hookToThread?: Readonly<Record<HookId, ThreadId>>
  /** 活跃伏笔上限（viewForChapter budget.cap），默认 12。 */
  readonly cap?: number
}

export const DEFAULT_FIXTURE: Required<Omit<FakeBookRuntimeOptions, 'cap'>> = {
  config: BOOK_CONFIG,
  ledger: HOOK_LEDGER,
  threads: THREADS,
  facts: FACTS,
  characters: CHARACTERS,
  characterStates: CHARACTER_STATES,
  hookToThread: HOOK_TO_THREAD,
}
