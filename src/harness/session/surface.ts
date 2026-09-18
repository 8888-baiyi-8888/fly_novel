/**
 * 会话事件日志之上的消息视图层：按顺序展示可生成 LLM 消息的事件，仅追加的日志仍是事实来源。
 * 浏览器安全：Web 客户端使用此子路径导出，因此不得引入会破坏 Vite 打包的 node: 模块。
 * @module @deepseek-ai/dsh-session/surface
 */

import type { Message } from '@fly-novel/llm'
import { SessionLogOffset, SessionSeq } from './types.ts'
import { KNOWN_SESSION_EVENT_TYPES, MESSAGE_PROJECTION_EVENT_TYPES } from './known-event-types.ts'
import type {
  SessionEvent,
  SessionEventType,
  SessionSeqCursor,
  SurfaceEvent,
  SurfaceOp,
} from './types.ts'

/** 消息投影事件发生前的只读历史。 */
export interface SessionMessageProjectionContext {
  /** 按模型可见顺序排列的当前消息事件序号。 */
  nodes: readonly SessionSeq[]
  /** 连续事件窗口；候选序号及其之后的事件不作为已提交的输入。 */
  events: readonly SessionEvent[]
  /** 窗口中首个事件的绝对序号。 */
  baseSeq: SessionLogOffset
  /** 以原始事件序号为键的已有消息投影。 */
  messages: ReadonlyMap<SessionSeq, Message>
}

/** 对插件拥有的、改变已有消息内容的单个事件进行纯函数解释。 */
export interface SessionMessageProjection<T extends SessionEventType = SessionEventType> {
  /** 本定义解释的事件；在 SessionEventMap 中使用 @messageProjection 声明。 */
  type: T
  /**
   * 返回更新前校验完整的持久化决策。保留消息标识，发布不可变副本，不修改输入。
   * @param event - 尚未应用到所提供历史的候选事件。
   * @param context - 此决策之前的历史。
   * @returns 以原始序号为键的已变更当前消息。
   * @throws 持久化决策无法应用到此历史时抛错。
   */
  project(event: SessionEvent<T>, context: SessionMessageProjectionContext): ReadonlyMap<SessionSeq, Message>
}

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
    // 普通提示词和注入上下文以 user 角色投影，面向模型的
    // 事件内容保持原样。不要在这里重新添加按类型区分的包装
    // （例如 <context>）：包装由调用方负责，生产者将其写入
    // content，例如 agent-instructions 使用 <system-reminder>。
    // 若重新引入包装，必须由事件 meta 映射和专用渲染器驱动，
    // 使本投影继续原样传递内容。设计背景见
    // 延期设计记录：
    // ../../../../.agents/notes/implemented/simplification/2026-07-20-unwrap-injected-content-envelopes.md
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

/** 判断载荷字段是否为 JSON 对象，而非数组或标量。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 拒绝不规范的请求头字段和相互矛盾的工具失败元数据。
 * 此处不校验完整事件载荷或内嵌的供应商响应流。
 * @param event - 要检查其载荷字段之间关系的事件。
 * @param subject - 校验错误中显示的事件位置。
 * @throws 请求数据或请求头不是对象、可选头字段为空，或工具失败元数据与消息矛盾时抛错。
 */
export function validateSessionEventData(
  event: Pick<SessionEvent, 'type' | 'data'>,
  subject: string,
): void {
  const data: unknown = event.data
  if (event.type === 'request/header') {
    if (!isRecord(data)) throw new Error(`${subject} data must be an object`)
    const header = data['header']
    if (!isRecord(header)) throw new Error(`${subject} header must be an object`)
    if (Object.hasOwn(header, 'system')) throw new Error(`${subject} must omit header.system; use system/message`)
    if (Array.isArray(header['tools']) && header['tools'].length === 0) {
      throw new Error(`${subject} must omit empty tools`)
    }
    const defaults = header['adapterDefaults']
    if (isRecord(defaults) && Object.keys(defaults).length === 0) {
      throw new Error(`${subject} must omit empty adapterDefaults`)
    }
  } else if (event.type === 'tool/result') {
    if (!isRecord(data)) throw new Error(`${subject} data must be an object`)
    if (data['error'] === undefined) return
    const message = data['message']
    const content = isRecord(message) ? message['content'] : undefined
    const block: unknown = Array.isArray(content) ? content[0] : undefined
    if (!isRecord(block) || block['isError'] !== true) {
      throw new Error(`${subject} error requires message content[0].isError === true`)
    }
  }
}

/** 折叠会话消息视图时观察到的一次替换操作。 */
export interface SurfaceFoldReplacement {
  /** 替换此前消息视图范围的事件序号。 */
  seq: SessionSeq
  /** 声明的替换范围起始序号，包含该位置。 */
  start: SessionSeq
  /** 声明的替换范围结束序号，包含该位置。 */
  end: SessionSeq
  /** 操作实际移除的视图条目，按视图顺序排列。 */
  shadowedSeqs: SessionSeq[]
}

/** 重放会话日志中消息视图操作的完整结果。 */
export interface SurfaceFoldResult {
  /** 按模型可见顺序排列的当前消息视图事件序号。 */
  nodes: SessionSeq[]
  /** 按事件顺序排列的替换操作。 */
  replacements: SurfaceFoldReplacement[]
  /** 以原始事件序号为键的不可变投影消息。 */
  projectedMessages: ReadonlyMap<SessionSeq, Message>
}

/** 可生成消息的会话事件的只读实时投影。 */
export interface SessionSurface {
  /** 按模型可见顺序排列的当前消息视图事件序号。 */
  readonly nodes: readonly SessionSeq[]
  /** 已提交的位置替换操作的单调递增计数。 */
  readonly replaceGeneration: number
  /** 已提交替换操作和插件消息变更的单调递增计数。 */
  readonly contentGeneration: number
}

/** 完整折叠与增量折叠共用的可变状态。 */
interface SurfaceFoldState {
  nodes: SessionSeq[]
  replaceGeneration: number
  contentGeneration: number
  projectedMessages: Map<SessionSeq, Message>
  projections: Set<SessionMessageProjection>
}

/** 已校验但尚未修改折叠状态的替换状态转换。 */
interface SurfaceReplacePlan extends SurfaceFoldReplacement {
  kind: 'replace'
  startIdx: number
  endIdx: number
}

/** 已校验但尚未修改折叠状态的一次消息视图状态转换。 */
type SurfacePlan =
  | { kind: 'append'; seq: SessionSeq }
  | SurfaceReplacePlan
  | { kind: 'project'; projection: SessionMessageProjection; messages: ReadonlyMap<SessionSeq, Message> }

/** 创建空的消息视图折叠状态。 */
function createFoldState(): SurfaceFoldState {
  return { nodes: [], replaceGeneration: 0, contentGeneration: 0, projectedMessages: new Map(), projections: new Set() }
}

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
      throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`)
    }
    if (raw.sourceEventSeqs !== undefined) {
      throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`)
    }
    return
  }
  const op = raw.surfaceOp
  if (op === undefined) {
    throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`)
  }
  if (op === 'append') return op
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    throw new Error(`session event "${event.type}" carries an invalid surfaceOp`)
  }
  if (!isReplaceOp(op)) {
    throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`)
  }
  return op
}

/** 根据此前日志条目和替换范围校验引用的源事件序号。 */
function assertSourceEventReferences(
  event: SessionEvent,
  shadowedSeqs: readonly SessionSeq[],
): void {
  const raw: unknown = event.sourceEventSeqs
  if (event.type === 'assistant/message' && raw !== undefined) {
    throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs')
  }
  const sources = new Set<SessionSeq>()
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      throw new Error(`sourceEventSeqs on event at seq ${event.seq} must be an array when present`)
    }
    if (raw.length === 0) {
      throw new Error('sourceEventSeqs must not be empty')
    }
    let nonEarlierSource: SessionSeq | undefined
    for (const source of raw) {
      if (!isEventSeq(source)) {
        throw new Error(`session event "${event.type}" sourceEventSeqs must densely contain non-negative safe integers`)
      }
      sources.add(source)
      if (nonEarlierSource === undefined && source >= event.seq) nonEarlierSource = source
    }
    if (sources.size !== raw.length) {
      throw new Error('sourceEventSeqs must not contain duplicates')
    }
    if (nonEarlierSource !== undefined) {
      throw new Error(`sourceEventSeqs must reference earlier events: ${nonEarlierSource} >= current seq ${event.seq}`)
    }
  }
  const missing = shadowedSeqs.filter(seq => !sources.has(seq))
  if (missing.length > 0) {
    throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`)
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
    throw new Error(`surface replace at seq ${event.seq}: startSeq and endSeq must reference earlier events`)
  }
  if (op !== undefined) assertSourceEventReferences(event, [])
  return op
}

/** 定位一次替换的范围，不修改当前折叠状态。 */
function replacementRange(
  state: SurfaceFoldState,
  op: Extract<SurfaceOp, { op: 'replace' }>,
): Pick<SurfaceReplacePlan, 'startIdx' | 'endIdx' | 'shadowedSeqs'> {
  const startIdx = state.nodes.indexOf(op.startSeq)
  if (startIdx === -1) {
    throw new Error(`surface replace: start seq ${op.startSeq} not found in surface`)
  }
  const endIdx = state.nodes.indexOf(op.endSeq)
  if (endIdx === -1) {
    throw new Error(`surface replace: end seq ${op.endSeq} not found in surface`)
  }
  if (startIdx > endIdx) {
    throw new Error(`surface replace: start seq ${op.startSeq} (index ${startIdx}) is after end seq ${op.endSeq} (index ${endIdx})`)
  }
  return {
    startIdx,
    endIdx,
    shadowedSeqs: state.nodes.slice(startIdx, endIdx + 1),
  }
}

/**
 * 对会话事件的 JSON 值域执行深层结构相等比较，包括 null、布尔值、数字、字符串、数组和普通对象。
 * 替代 node:util 的 isDeepStrictEqual，使本模块可在浏览器使用。
 */
function isDeepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => isDeepEqualJson(item, b[i]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a)
  const bRecord = b as Record<string, unknown>
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every(key => Object.hasOwn(b, key) && isDeepEqualJson((a as Record<string, unknown>)[key], bRecord[key]))
}

/** 将工具结果替换限制为当前某一个结果的内容。 */
function assertToolResultRewrite(
  event: SessionEvent,
  shadowedSeqs: readonly SessionSeq[],
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
): void {
  if (event.type !== 'tool/result') return
  if (shadowedSeqs.length !== 1) {
    throw new Error('tool/result surface replacement must rewrite exactly one current node')
  }
  for (const originalSeq of shadowedSeqs) {
    const original = events[originalSeq - baseSeq]
    if (original?.type !== 'tool/result') {
      throw new Error('tool/result surface replacement must target a current tool/result')
    }
    const originalRest = { ...original.data } as Record<string, unknown>
    const replacementRest = { ...event.data } as Record<string, unknown>
    const originalResult = original.data.message.content[0]
    const replacementResult = event.data.message.content[0]
    originalRest['message'] = {
      ...original.data.message,
      content: [{ ...originalResult, content: null }],
    }
    replacementRest['message'] = {
      ...event.data.message,
      content: [{ ...replacementResult, content: null }],
    }
    if (!isDeepEqualJson(originalRest, replacementRest)) {
      throw new Error('tool/result surface replacement may change only content')
    }
  }
}

/**
 * 保护消息视图第 0 个节点的系统提示词。若替换范围覆盖该节点且它为 system/message，
 * 替换事件也必须是 system/message，且只能替换该节点。
 * 后续系统节点不受此保护，可以被压缩范围遮蔽。
 */
function assertSystemHeadRewrite(
  event: SessionEvent,
  state: SurfaceFoldState,
  startIdx: number,
  shadowedSeqs: readonly SessionSeq[],
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
): void {
  if (startIdx !== 0) return
  const head = events[state.nodes[0] as number - baseSeq]
  if (head?.type !== 'system/message') return
  if (event.type !== 'system/message' || shadowedSeqs.length !== 1) {
    throw new Error('surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node')
  }
}

/** 在重放边界校验单个事件，并准备原子的折叠状态转换。 */
function planSurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
  expectedSeq: SessionSeq,
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
  projections: readonly SessionMessageProjection[],
): SurfacePlan | undefined {
  if (event.seq !== expectedSeq) {
    throw new Error(`session event seq ${event.seq} is not contiguous; expected ${expectedSeq}`)
  }
  const surfaceOp = validateSurfaceMetadata(event)
  const projection = projections.find(item => item.type === event.type)
  if (projection !== undefined) {
    return { kind: 'project', projection, messages: projection.project(event, {
      nodes: state.nodes, events, baseSeq, messages: state.projectedMessages,
    }) }
  }
  if (MESSAGE_PROJECTION_EVENT_TYPES.has(event.type)) {
    throw new Error(`session event "${event.type}" requires a message projection; load its owning plugin or supply its projection definition`)
  }
  if (surfaceOp === undefined) return
  if (surfaceOp === 'append') {
    return { kind: 'append', seq: event.seq }
  }
  const range = replacementRange(state, surfaceOp)
  assertSourceEventReferences(event, range.shadowedSeqs)
  assertToolResultRewrite(event, range.shadowedSeqs, events, baseSeq)
  assertSystemHeadRewrite(event, state, range.startIdx, range.shadowedSeqs, events, baseSeq)
  return {
    kind: 'replace',
    seq: event.seq,
    start: surfaceOp.startSeq,
    end: surfaceOp.endSeq,
    ...range,
  }
}

/** 应用单个事件，仅在发生替换时返回替换元数据。 */
function applySurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
  expectedSeq: SessionSeq,
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
  projections: readonly SessionMessageProjection[],
): SurfaceFoldReplacement | undefined {
  const plan = planSurfaceEvent(state, event, expectedSeq, events, baseSeq, projections)
  return applySurfacePlan(state, plan)
}

/** 提交此前已校验的一次消息视图状态转换。 */
function applySurfacePlan(
  state: SurfaceFoldState,
  plan: SurfacePlan | undefined,
): SurfaceFoldReplacement | undefined {
  if (plan?.kind === 'append') {
    state.nodes.push(plan.seq)
  } else if (plan?.kind === 'replace') {
    state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq)
    state.replaceGeneration += 1
    state.contentGeneration += 1
  } else if (plan?.kind === 'project') {
    for (const [seq, message] of plan.messages) state.projectedMessages.set(seq, message)
    state.projections.add(plan.projection)
    state.contentGeneration += 1
  }
  if (plan?.kind !== 'replace') return
  return {
    seq: plan.seq,
    start: plan.start,
    end: plan.end,
    shadowedSeqs: plan.shadowedSeqs,
  }
}

/**
 * 通过标准消息视图折叠流程重放完整会话日志。
 * @param events - 按连续序号排列的会话事件。
 * @param projections - 插件消息变更的纯函数解释器；必须提供所需定义。
 * @returns 与内部状态分离的当前序号和替换历史。
 * @throws 缺少解释器，或事件违反投影、视图元数据、来源归属或替换规则时抛错。
 */
export function foldSurface(events: readonly SessionEvent[], projections: readonly SessionMessageProjection[] = []): SurfaceFoldResult {
  const state = createFoldState()
  const replacements: SurfaceFoldReplacement[] = []
  for (const [index, event] of events.entries()) {
    const replacement = applySurfaceEvent(
      state,
      event,
      SessionSeq(index),
      events,
      SessionLogOffset(0),
      projections,
    )
    if (replacement !== undefined) replacements.push(replacement)
  }
  return { nodes: [...state.nodes], replacements, projectedMessages: new Map(state.projectedMessages) }
}

/** 增量维护有序消息视图，并在追加边界执行校验。 */
export class SurfaceManager implements SessionSurface {
  /** 共享的状态转换状态；不保留替换历史。 */
  private _state = createFoldState()
  /** 最后处理的绝对序号。 */
  private _lastProcessedSeq: SessionSeqCursor
  /** 已由 validateNext 校验、等待日志精确接纳的候选事件。 */
  private _pendingPlan: { event: SessionEvent; expectedSeq: SessionSeq; plan: SurfacePlan | undefined } | undefined

  /**
   * @param log - 连续的完整日志或已加载的事件窗口。
   * @param baseSeq - 窗口首个事件的绝对序号。
   * @param projections - 借用的实时定义；移除已使用的定义会使后续读取失效。
   */
  constructor(
    private log: readonly SessionEvent[],
    private readonly baseSeq: SessionLogOffset = SessionLogOffset(0),
    private readonly projections: readonly SessionMessageProjection[] = [],
  ) {
    this._lastProcessedSeq = baseSeq === 0 ? -1 : SessionSeq(baseSeq - 1)
  }

  /**
   * 校验下一个候选事件，不修改已提交的消息视图。
   * @param event - 尚未进入日志的候选事件。
   */
  validateNext(event: SessionEvent): void {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    const expectedSeq = SessionSeq(this.baseSeq + this.log.length)
    this._pendingPlan = {
      event,
      expectedSeq,
      plan: planSurfaceEvent(this._state, event, expectedSeq, this.log, this.baseSeq, this.projections),
    }
  }

  /** 已折叠的位置替换操作的单调递增计数。 */
  get replaceGeneration(): number {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return this._state.replaceGeneration
  }

  /** 对已有模型可见内容所提交变更的单调递增计数。 */
  get contentGeneration(): number {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return this._state.contentGeneration
  }

  /**
   * 对单个消息应用所有已提交的消息投影。
   * @param event - 可生成消息的事件或仅日志事件。
   * @returns 不可变的投影消息；不生成消息时返回 null。
   */
  deriveEventMessage(event: SessionEvent): Message | null {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return deriveEventMessage(event, this._state.projectedMessages)
  }

  /** 按模型可见顺序排列的消息视图事件序号。 */
  get nodes(): readonly SessionSeq[] {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return this._state.nodes
  }

  /** 折叠上次访问后追加的事件。 */
  private _processDelta(): void {
    const tailSeq = this.baseSeq + this.log.length - 1
    for (let seq = this._lastProcessedSeq + 1; seq <= tailSeq; seq++) {
      const index = seq - this.baseSeq
      // oxlint-disable-next-line typescript/no-non-null-assertion -- 下标受循环条件约束
      const event = this.log[index]!
      const pending = this._pendingPlan
      if (pending?.event === event && pending.expectedSeq === seq) {
        applySurfacePlan(this._state, pending.plan)
      } else {
        applySurfaceEvent(this._state, event, SessionSeq(seq), this.log, this.baseSeq, this.projections)
      }
      if (pending !== undefined && pending.expectedSeq <= seq) this._pendingPlan = undefined
      this._lastProcessedSeq = SessionSeq(seq)
    }
  }

  /** 解释日志所用的定义失效后，不得继续使用缓存消息。 */
  private _assertProjections(): void {
    const candidate = this._pendingPlan
    const pending = candidate !== undefined && this.log[candidate.expectedSeq - this.baseSeq] === candidate.event
      ? candidate.plan : undefined
    const required = pending?.kind === 'project'
      ? [...this._state.projections, pending.projection]
      : this._state.projections
    for (const projection of required) {
      if (!this.projections.includes(projection)) {
        throw new Error(`session message projection "${projection.type}" was removed or replaced; restore the session with its owning plugin`)
      }
    }
  }
}
