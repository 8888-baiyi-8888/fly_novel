import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildFakeBookRuntime, type FakeBookRuntime } from './fake-book-runtime.ts'
import type { FakeBookRuntimeOptions } from './fixtures.ts'
import type { BookConfig } from '../types/book-config.ts'
import type { CharacterCard, CharacterState, Tier } from '../types/character.ts'
import type { CharacterName, EventId, FactId, HookId, ThreadId, BookId } from '../types/identifiers.ts'
import type { Fact, SubjectKind } from '../types/fact.ts'
import type { HookRecord, HookStatus, HookTiming, HookType } from '../types/hook.ts'
import type { Thread, ThreadEvent, ThreadKind, ThreadStatus } from '../types/thread.ts'

/**
 * 书目录 → BookRuntime 适配器（小说流 N7 工作空间 → 章节流 BookRuntime）。
 *
 * 输入（小说流真实产物，N8 交接点的唯一事实源）：
 *   {workspaceDir}/inkos.json                 —— BookConfig + 平台参数
 *   {workspaceDir}/state/hooks.json           —— 伏笔种子（HookSeed）
 *   {workspaceDir}/state/threads.json         —— 叙事线调度视图（ThreadBoardState）
 *   {workspaceDir}/state/facts.json           —— 事实库（压缩三元组投影）
 *   {workspaceDir}/story/beats/beats.json     —— 节拍板（hookToThread 反推 + 线角色推导）
 * 可选补源（书目录自包含度缺口，见下方"缺口"）：
 *   artifacts/n5-architecture/architecture-*.json —— 角色卡 JSON（characterCards）+ 叙事线本体（threadMap）
 *   artifacts/n6-state0/state0-*.json         —— 结构化角色状态（characterStates）
 *
 * 输出：FakeBookRuntimeOptions → buildFakeBookRuntime（复用章节流既有内存运行时，节点与引擎零改动）。
 *
 * 缺口（2026-09-28 对接《初夏逢清晏》真实产物时确认，适配层用"可选补源 + 最小兜底"处理）：
 * 1. 书目录未 JSON 化角色卡（只有 story/characters.md 人读投影）→ 从 N5 architecture 产物补读；
 * 2. 书目录 facts.json 是「位置｜身份｜情绪｜认知｜资源」压缩字符串 → 结构化角色状态从 N6 state0 补读；
 * 3. 小说流产物无 goals / fears / bonds 数值 / Fact.knownBy → 初始为空，随章节 settle 逐步建立；
 * 4. ThreadEvent 无章节数值（只有卷字符串）→ chapter=null（canReach 依赖线时钟 syncPoint，不受影响）。
 */

/* ---------------- 书目录原始形状（小说流 N7 产物，机器读权威） ---------------- */

export interface InkFile {
  readonly bookId: string
  readonly title: string
  readonly bookConfig: Omit<BookConfig, 'bookId'> & { readonly bookId: string }
}

/** 伏笔种子：State₀ 的 hookSeeds 元素（book-workspace 直接用 hooks.json，字段与 state0 同构）。 */
export interface HookSeed {
  readonly hookId: string
  readonly beatTag: string
  readonly plantedChapter: number
  readonly type: string
  readonly timing: string
  readonly core: string
  readonly expectedPayoff: number
  readonly payoffNote: string
  readonly notes: string
}

export interface ThreadBoardState {
  readonly lineId: string
  readonly status: string
  readonly currentEvent: string | null
  readonly nextEvent: string | null
  readonly waitingFor: readonly string[]
  readonly estimatedWake: string
}

export interface WorkspaceFact {
  readonly subject: string
  readonly predicate: string
  readonly value: string
}

export interface BeatIntentionsBeat {
  readonly chapter: number
  readonly title: string
  readonly mainBeat: string
  readonly characters: readonly { readonly name: string; readonly action: string }[]
  readonly threadId: string
  readonly pacing: string
  readonly emotionalArc: string
  readonly hookIntentions: readonly string[]
  readonly plannedPayoffOf: readonly string[]
}

/** N5 architecture 产物（角色卡与叙事线本体的 JSON 来源）。 */
export interface ArchitectureFile {
  readonly bookId: string
  readonly characterCards?: readonly CharacterCardLike[]
  readonly threadMap?: { readonly lines?: readonly ThreadMapLine[] }
}

export interface CharacterCardLike {
  readonly name: string
  readonly tier: string
  readonly archetype: string
  readonly traits: readonly string[]
  readonly speechStyle: string
  readonly secret: string
  readonly knowledgeBoundary: readonly string[]
  readonly relationships: readonly { readonly name: string; readonly relation: string }[]
}

export interface ThreadMapLine {
  readonly id: string
  readonly name: string
  readonly goal: string
  readonly events: readonly {
    readonly id: string
    readonly content: string
    readonly volume: string
    readonly requires: readonly string[]
    readonly merge: boolean
  }[]
}

/** N6 state0 产物（结构化角色状态的 JSON 来源）。 */
export interface State0File {
  readonly bookId: string
  readonly characterStates?: readonly State0CharacterState[]
  readonly relationshipStates?: readonly { readonly subjects: readonly string[]; readonly relation: string; readonly trust: string; readonly knowledge: string }[]
  readonly worldState?: readonly { readonly key: string; readonly value: string }[]
  readonly progressState?: { readonly currentChapter: number }
}

export interface State0CharacterState {
  readonly name: string
  readonly location: string
  readonly identity: string
  readonly emotion: string
  readonly cognition: string
  readonly resources: string
}

/* ---------------- 纯映射函数（确定性、无 I/O，可直接单测） ---------------- */

/** ①BookConfig：inkos.bookConfig 与章节流同构，直接透传（platform 为原文，如「晋江文学城」）。 */
export function mapBookConfig(ink: InkFile): BookConfig {
  const c = ink.bookConfig
  return {
    bookId: c.bookId as BookId,
    title: c.title,
    genre: c.genre,
    platform: c.platform,
    targetChapters: c.targetChapters,
    chapterWordCount: c.chapterWordCount,
    language: c.language,
    chapterReviewMode: c.chapterReviewMode,
    maxHookRetries: c.maxHookRetries,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

/** 小说流 timing 值域与章节流 HookTiming 完全一致（immediate/near-term/mid-arc/slow-burn/endgame）。 */
const TIMING: Readonly<Record<string, HookTiming>> = {
  immediate: 'immediate',
  'near-term': 'near-term',
  'mid-arc': 'mid-arc',
  'slow-burn': 'slow-burn',
  endgame: 'endgame',
}

/** 小说流 HookSeed.type 值域与章节流 HookType 词表（HOOK_TYPES）一致；未知类型在此显式拒绝（防静默失真）。 */
const TYPES: Readonly<Record<string, HookType>> = {
  物件: '物件', 身份: '身份', 信息差: '信息差', 承诺: '承诺', 威胁: '威胁', 秘密: '秘密', 关系: '关系', 能力: '能力', 事件: '事件',
}

/** ②伏笔账本：HookSeed → HookRecord。初始全部 open（从未推进）；coreHook = core 非空。 */
export function mapHookLedger(seeds: readonly HookSeed[]): Readonly<Record<HookId, HookRecord>> {
  const out: Record<HookId, HookRecord> = {}
  for (const seed of seeds) {
    const type = TYPES[seed.type]
    if (type === undefined) throw new Error(`book-workspace：伏笔 ${seed.hookId} 的类型「${seed.type}」不在章节流词表内`)
    const timing = TIMING[seed.timing]
    if (timing === undefined) throw new Error(`book-workspace：伏笔 ${seed.hookId} 的 timing「${seed.timing}」不在档位表内`)
    out[seed.hookId as HookId] = {
      hookId: seed.hookId as HookId,
      startChapter: seed.plantedChapter,
      type,
      status: 'open',
      lastAdvancedChapter: 0,
      advancedCount: 0,
      expectedPayoff: seed.payoffNote,
      payoffTiming: timing,
      coreHook: seed.core.trim() !== '',
      notes: seed.notes,
    }
  }
  return out as Readonly<Record<HookId, HookRecord>>
}

const THREAD_KIND: Readonly<Record<string, ThreadKind>> = { M: 'main', S: 'side', F: 'flashback', I: 'interlude' }
const THREAD_STATUS: Readonly<Record<string, ThreadStatus>> = { 进行中: 'active', 冷藏: 'dormant', 已完成: 'completed' }

/** 叙事线调度状态 → 线状态（状态迁移方向：active ↔ dormant，completed 为终态）。 */
export function mapThreadStatus(raw: string): ThreadStatus {
  const status = THREAD_STATUS[raw]
  if (status === undefined) throw new Error(`book-workspace：未知叙事线状态「${raw}」`)
  return status
}

/** ③叙事线：ThreadBoardState（调度）+ ThreadMap（逻辑）→ 章节流 Thread。
 * kind 由 lineId 前缀推导；eventChain 优先取 threadMap.events，缺省用 currentEvent/nextEvent 兜底；
 * characters 从节拍板反推（threadId 归属线的出场角色去重）。 */
export function mapThreads(
  board: readonly ThreadBoardState[],
  lines: readonly ThreadMapLine[] | undefined,
  beats: readonly BeatIntentionsBeat[],
): readonly Thread[] {
  const characterOfLine = new Map<string, CharacterName[]>()
  for (const beat of beats) {
    const names = characterOfLine.get(beat.threadId) ?? []
    for (const c of beat.characters) {
      if (!names.includes(c.name as CharacterName)) names.push(c.name as CharacterName)
    }
    characterOfLine.set(beat.threadId, names)
  }

  return board.map((entry) => {
    const kind = THREAD_KIND[entry.lineId[0]] ?? 'side'
    const line = lines?.find((l) => l.id === entry.lineId)
    const events: ThreadEvent[] =
      line === undefined
        ? [entry.currentEvent, entry.nextEvent]
            .filter((id): id is string => id !== null)
            .map((id, i) => ({
              eventId: id as EventId,
              summary: i === 0 ? entry.estimatedWake : entry.estimatedWake,
              chapter: null,
              prerequisiteEventIds: [],
              status: 'pending',
            }))
        : line.events.map((e) => ({
            eventId: e.id as EventId,
            summary: e.content,
            chapter: null,
            volumeRange: e.volume,
            prerequisiteEventIds: e.requires as EventId[],
            isConvergencePoint: e.merge,
            status: 'pending',
          }))
    return {
      threadId: entry.lineId as ThreadId,
      kind,
      title: line?.name ?? entry.lineId,
      status: mapThreadStatus(entry.status),
      priority: kind === 'main' ? 10 : kind === 'flashback' ? 3 : 5,
      syncPoint: 0,
      speed: kind === 'main' ? 1 : 0.3,
      eventChain: events,
      characters: characterOfLine.get(entry.lineId) ?? [],
    }
  })
}

/** ④事实库：书目录 facts.json（subject/predicate/value 压缩三元组）→ 章节流 Fact。
 * subjectType 由 subject 形状推导（世界→world、含「+」→relationship、其余→character）；
 * 压缩 value 原样作为 object（信息不丢失；结构化语义由 characterStates 承载）。 */
export function mapFacts(facts: readonly WorkspaceFact[]): readonly Fact[] {
  return facts.map((f, i) => {
    const subjectType: SubjectKind = f.subject === '世界' ? 'world' : f.subject.includes('+') ? 'relationship' : 'character'
    return {
      factId: `F${String(i + 1).padStart(3, '0')}` as FactId,
      subject: f.subject,
      subjectType,
      predicate: f.predicate,
      object: f.value,
      validFromChapter: 1,
      validUntilChapter: null,
      sourceChapter: 1,
      status: 'active',
    }
  })
}

/** ⑤角色卡：N5 characterCards（书目录无 JSON 化角色卡，缺省时由节拍板角色名兜底生成最小卡）。 */
export function mapCharacters(
  cards: readonly CharacterCardLike[] | undefined,
  beats: readonly BeatIntentionsBeat[],
): readonly CharacterCard[] {
  if (cards !== undefined && cards.length > 0) {
    return cards.map((c) => ({
      name: c.name as CharacterName,
      tier: (c.tier === 'S' || c.tier === 'A' || c.tier === 'B' ? c.tier : 'B') as Tier,
      archetype: c.archetype,
      aliases: [],
      traits: c.traits ?? [],
      speechStyle: c.speechStyle,
      goals: [],
      fears: [],
      secret: c.secret,
      knowledgeBoundary: c.knowledgeBoundary ?? [],
      relationships: (c.relationships ?? []).map((r) => ({ target: r.name as CharacterName, type: r.relation, desc: r.relation })),
    }))
  }
  const names: CharacterName[] = []
  for (const beat of beats) {
    for (const c of beat.characters) {
      if (!names.includes(c.name as CharacterName)) names.push(c.name as CharacterName)
    }
  }
  return names.map((name) => ({
    name, tier: 'B', archetype: '', aliases: [], traits: [], speechStyle: '', goals: [], fears: [],
    secret: '', knowledgeBoundary: [], relationships: [],
  }))
}

/** ⑥角色运行时状态：N6 state0.characterStates → 章节流 CharacterState。
 * 小说流产物无 goal/suspects/inventory/bonds 数值 → 初始为空（随 settle 建立）；knows 由 Fact.knownBy 派生（初始无人登记）。 */
export function mapCharacterStates(states: readonly State0CharacterState[] | undefined): Readonly<Record<CharacterName, CharacterState>> {
  const out: Record<CharacterName, CharacterState> = {}
  for (const s of states ?? []) {
    out[s.name as CharacterName] = {
      name: s.name as CharacterName,
      location: s.location,
      goal: '',
      emotion: s.emotion,
      knows: [],
      suspects: [],
      inventory: [],
      bonds: {},
    }
  }
  return out as Readonly<Record<CharacterName, CharacterState>>
}

/** ⑦伏笔→叙事线归属（canReach 判定用）：从节拍板 hookIntentions（【tag】前缀）反推。
 * 每个 seed 的 beatTag 应恰好在某条 beat 的 hookIntentions 里出现（埋设章即该 beat 的 threadId）。 */
export function mapHookToThread(
  seeds: readonly HookSeed[],
  beats: readonly BeatIntentionsBeat[],
): Readonly<Record<HookId, ThreadId>> {
  const tagOfBeat = new Map<string, string>()
  for (const beat of beats) {
    for (const intention of beat.hookIntentions) {
      const m = /【(ch\d+-h\d+)】/.exec(intention)
      if (m !== null) tagOfBeat.set(m[1], beat.threadId)
    }
  }
  const out: Record<HookId, ThreadId> = {}
  for (const seed of seeds) {
    const threadId = tagOfBeat.get(seed.beatTag)
    if (threadId !== undefined) out[seed.hookId as HookId] = threadId as ThreadId
  }
  return out as Readonly<Record<HookId, ThreadId>>
}

/* ---------------- 文件加载与运行时构建（I/O 边界，仅此函数触及文件系统） ---------------- */

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** 在 artifacts 根下定位 bookId 匹配的最新 N5/N6 产物；找不到返回 undefined。 */
function findLatestArtifact(artifactsRoot: string, dir: string, bookId: string): string | undefined {
  const dirPath = join(artifactsRoot, dir)
  if (!existsSync(dirPath)) return undefined
  // 命名约定 {name}-{yyyyMMdd-HHmmss}.json → 按文件名倒序即最新在前
  const files = readdirSync(dirPath).sort((a, b) => (a < b ? 1 : -1))
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const json = readJson<{ bookId?: string }>(join(dirPath, file))
      if (json.bookId === bookId) return join(dirPath, file)
    } catch {
      // 跳过损坏产物，继续找下一个
    }
  }
  return undefined
}

export interface BookWorkspaceOptions {
  /** artifacts 根目录（N5/N6 产物定位基准）；缺省由 workspaceDir 上溯两级推断（…/artifacts/n7-workspace/{bookId}）。 */
  readonly artifactsRoot?: string
  /** 显式 N5 architecture JSON 路径（跳过自动定位）。 */
  readonly architecturePath?: string
  /** 显式 N6 state0 JSON 路径（跳过自动定位）。 */
  readonly state0Path?: string
}

/** 从小说流书目录构建章节流 BookRuntime（可跨章持久化的 FakeBookRuntime）。 */
export function buildRuntimeFromBookWorkspace(workspaceDir: string, options: BookWorkspaceOptions = {}): FakeBookRuntime {
  const ink = readJson<InkFile>(join(workspaceDir, 'inkos.json'))
  const seeds = readJson<{ hooks: readonly HookSeed[] }>(join(workspaceDir, 'state', 'hooks.json')).hooks
  const board = readJson<{ threadBoard: readonly ThreadBoardState[] }>(join(workspaceDir, 'state', 'threads.json')).threadBoard
  const facts = readJson<{ facts: readonly WorkspaceFact[] }>(join(workspaceDir, 'state', 'facts.json')).facts
  const beats = readJson<{ beats: readonly BeatIntentionsBeat[] }>(join(workspaceDir, 'story', 'beats', 'beats.json')).beats

  const artifactsRoot = options.artifactsRoot ?? join(workspaceDir, '..', '..')
  const architecturePath = options.architecturePath ?? findLatestArtifact(artifactsRoot, 'n5-architecture', ink.bookId)
  const state0Path = options.state0Path ?? findLatestArtifact(artifactsRoot, 'n6-state0', ink.bookId)

  const architecture = architecturePath === undefined ? undefined : readJson<ArchitectureFile>(architecturePath)
  const state0 = state0Path === undefined ? undefined : readJson<State0File>(state0Path)

  const mapped: FakeBookRuntimeOptions = {
    config: mapBookConfig(ink),
    ledger: mapHookLedger(seeds),
    threads: mapThreads(board, architecture?.threadMap?.lines, beats),
    facts: mapFacts(facts),
    characters: mapCharacters(architecture?.characterCards, beats),
    characterStates: mapCharacterStates(state0?.characterStates),
    hookToThread: mapHookToThread(seeds, beats),
    cap: (ink as unknown as { platformProfile?: { hook?: { maxActive?: number } } }).platformProfile?.hook?.maxActive ?? 12,
  }

  const runtime = buildFakeBookRuntime(mapped)
  // 书目录事实库 → 真相库快照；角色卡 JSON 缺失时给调用方可见提示（对接期已知缺口）
  if (architecture === undefined) console.warn(`book-workspace：未定位到 N5 architecture 产物，角色卡使用节拍板兜底（${runtime.characters.length} 张）`)
  if (state0 === undefined) console.warn('book-workspace：未定位到 N6 state0 产物，角色运行时状态为空（等待小说流将 characterStates 并入书目录）')
  return runtime
}

/** 便捷函数：给定书目录路径与可选项，构建运行时。run-chapter --workspace 直接调用。 */
export function loadBookRuntime(workspaceDir: string, options: BookWorkspaceOptions = {}): FakeBookRuntime {
  return buildRuntimeFromBookWorkspace(workspaceDir, options)
}
