import type { 
  EpochHeader, SessionEvent,SessionHeader, SessionId,SessionEventMap,SurfaceIntent,
  RequestContext, SessionSeedEventState,SurfaceEventType,SessionEventType
 } from "./types.ts";
 import {SessionLogOffset, SESSION_FORMAT_VERSION,SessionSeq} from "./types.ts"
import {SurfaceManager} from "./surface.ts"
import type { SessionSurface, SessionMessageProjection } from './surface.ts'
import type {Message} from '@fly-novel/llm'
import { isAbsolute } from "node:path";
import {deepFreeze,snapshotJsonValue} from '@fly-novel/util'
import {validateSessionEventData} from "./surface.ts"
import { Scoped } from "../scope/index.ts";
import { Context} from '@deepseek-ai/cordis'
import { foldRequestHeader } from "./request-header.ts";
/** Invoke one resolved observe-only listener snapshot with per-listener containment. */
function invokeContainedSessionObservers(
  ctx: Context,
  name: 'session/event' | 'session/disposed',
  id: SessionId,
  args: unknown[],
  callbacks: SessionCallback[],
): void {
  for (const callback of callbacks) {
    try {
      const returned: unknown = callback(...args)
      void Promise.resolve(returned).catch((error: unknown) => {
        ctx.logger.warn(`session "${id}": ${name} listener rejected: ${String(error)}`)
      })
    } catch (error: unknown) {
      ctx.logger.warn(`session "${id}": ${name} listener threw: ${String(error)}`)
    }
  }
}

/** Validate and freeze one detached creation header in place. */
function validateSessionHeader(id: SessionId, input: unknown): SessionHeader {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('session header is not a plain JSON record')
  }
  const record = input as Record<string, unknown>
  if (Object.hasOwn(record, 'seedLength')) {
    throw new Error('session header has invalid field "seedLength"')
  }
  if (record.version !== SESSION_FORMAT_VERSION) {
    throw new Error(`session header version must be ${SESSION_FORMAT_VERSION}, got ${String(record.version)}`)
  }
  if (record.id !== id) {
    throw new Error(`session header id "${String(record.id)}" does not match session id "${id}"`)
  }
  if (typeof record.createdAt !== 'number'
    || !Number.isSafeInteger(record.createdAt)
    || record.createdAt < 0) {
    throw new Error('session header createdAt must be a non-negative safe integer')
  }
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== 'string') throw new Error('session header cwd must be a string')
    if (!isAbsolute(record.cwd)) {
      throw new Error(`session header cwd must be an absolute path, got "${record.cwd}"`)
    }
  }
  if (record.parentSession !== undefined && typeof record.parentSession !== 'string') {
    throw new Error('session header parentSession must be a string')
  }
  if (typeof record.isSeeded !== 'boolean') {
    throw new Error('session header isSeeded must be a boolean')
  }
  if (record.origin !== undefined && record.origin !== 'subagent') {
    throw new Error('session header origin must be "subagent"')
  }
  if (record.delegationDepth !== undefined
    && (typeof record.delegationDepth !== 'number' || !Number.isSafeInteger(record.delegationDepth) || record.delegationDepth < 0)) {
    throw new Error('session header delegationDepth must be a non-negative safe integer')
  }
  if (record.agentPreset !== undefined && typeof record.agentPreset !== 'string') {
    throw new Error('session header agentPreset must be a string')
  }
  return deepFreeze(record as unknown as SessionHeader)
}
/** Validate and freeze one exclusively owned persistence header in place. */
function validateRestoredSessionHeader(id: SessionId, input: unknown): SessionHeader {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const prototype = Reflect.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('session header is not a plain JSON record')
    }
  }
  return validateSessionHeader(id, input)
}
/** All mutable lifecycle state for one exact store entry. */
interface SessionEntry {
  readonly id: SessionId
  readonly session: Session
  readonly carrier: Scoped<Session>
  readonly emitCtx: Context
  announced: boolean
  announcing: boolean
  appending: boolean
  detachRequested: boolean
  detach(): void
}
/** Store attachment for the append path; module-private to keep Session store-agnostic publicly. */
const attachments = new WeakMap<Session, SessionEntry>()
/** Validate the fixed event envelope after one-pass JSON materialization. */
function assertSessionEventEnvelope(value: unknown, index: number): asserts value is SessionEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`seed event at index ${index} has an invalid event envelope`)
  }
  const event = value as Record<string, unknown>
  for (const key in event) {
    switch (key) {
      case 'type':
      case 'seq':
      case 'time':
      case 'data':
      case 'surfaceOp':
      case 'sourceEventSeqs':
      case 'ignorable':
        break
      default:
        throw new Error(`seed event at index ${index} has an invalid event envelope`)
    }
  }
  const type = event['type']
  const seq = event['seq']
  const time = event['time']
  if (typeof type !== 'string'
    || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0)
    || typeof time !== 'number' || !Number.isSafeInteger(time)
    || event['data'] === undefined
    || (event['ignorable'] !== undefined && event['ignorable'] !== true)) {
    throw new Error(`seed event at index ${index} has an invalid event envelope`)
  }
  validateSessionEventData(event as SessionEvent, `seed ${type} at index ${index}`)
  switch (type) {
    case 'request/header':
    case 'system/message':
    case 'user/message':
    case 'assistant/attempt':
    case 'assistant/message':
    case 'tool/result':
      assertCurrentLlmShape(event, index)
      break
  }
}
/** Reject obsolete request headers and malformed messages at the seed/load boundary. */
function assertCurrentLlmShape(event: Record<string, unknown>, index: number): void {
  const data = event['data']
  const record = typeof data === 'object' && data !== null
    ? data as Record<string, unknown>
    : undefined
  if (event['type'] === 'request/header') {
    const headerRecord = record?.['header'] as Record<string, unknown>
    const config = headerRecord['config']
    if (!hasProviderModel(config)) throw new Error(`seed request/header at index ${index} lacks provider/model`)
    const configRecord = config as Record<string, unknown>
    const reasoningEffort = configRecord['reasoningEffort']
    if (reasoningEffort !== undefined
      && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) {
      throw new Error(`seed request/header at index ${index} has an invalid reasoningEffort`)
    }
    assertAdapterDefaults(headerRecord['adapterDefaults'], configRecord, index)
    const reason = record?.['reason']
    if (reason !== 'initial' && reason !== 'resume' && reason !== 'change' && reason !== 'series') {
      throw new Error(`seed request/header at index ${index} has an invalid reason`)
    }
    if (record?.['startsSeries'] !== undefined && record['startsSeries'] !== true) {
      throw new Error(`seed request/header at index ${index} has an invalid startsSeries marker`)
    }
  }
  const type = event['type']
  if (type === 'assistant/attempt') {
    assertAssistantSettlementShape(record, type, index)
    return
  }
  if (!isMessageEventType(type)) return
  assertMessageEventShape(event, `seed ${type} at index ${index}`)
  if (type === 'assistant/message') {
    assertAssistantSettlementShape(record, type, index)
  }
}
const MESSAGE_ROLE_BY_TYPE: Record<SurfaceEventType, Message['role']> = {
  'system/message': 'system',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'user',
}
/** Resolve one listener snapshot, including Cordis's internal dispatch checks. */
function collectSessionCallbacks(ctx: Context, args: unknown[]): SessionCallback[] {
  return [...ctx.events.dispatch('emit', args)] as SessionCallback[]
}
/** Validate only the event-specific invariants needed to safely replay a message. */
function assertMessageEventShape(event: Record<string, unknown>, subject: string): void {
  const type = event['type']
  if (!isMessageEventType(type)) return
  const data = event['data']
  const record = typeof data === 'object' && data !== null
    ? data as Record<string, unknown>
    : undefined
  const message = type === 'user/message' ? record : record?.['message']
  if (typeof message !== 'object' || message === null
    || typeof (message as Record<string, unknown>)['id'] !== 'string'
    || (message as Record<string, unknown>)['id'] === '') {
    throw new Error(`${subject} lacks an identified message`)
  }
  const messageRecord = message as Record<string, unknown>
  const expectedRole = MESSAGE_ROLE_BY_TYPE[type]
  if (messageRecord['role'] !== expectedRole) {
    throw new Error(`${subject} message must have role "${expectedRole}"`)
  }
  const source = messageRecord['source']
  if (typeof source !== 'object' || source === null
    || typeof (source as Record<string, unknown>)['kind'] !== 'string'
    || (source as Record<string, unknown>)['kind'] === '') {
    throw new Error(`${subject} message has invalid source`)
  }
  if (!Array.isArray(messageRecord['content'])) {
    throw new Error(`${subject} message has invalid content`)
  }
  const sourceRecord = source as Record<string, unknown>
  if (type === 'system/message') {
    if (sourceRecord['kind'] !== 'plugin' || typeof sourceRecord['plugin'] !== 'string'
      || sourceRecord['plugin'] === '') {
      throw new Error(`${subject} message must have plugin source`)
    }
    return
  }
  if (type === 'assistant/message') {
    if (sourceRecord['kind'] !== 'model' || !hasProviderModel(sourceRecord)) {
      throw new Error(`${subject} message must have model source`)
    }
    return
  }
  if (type !== 'tool/result') return
  if (sourceRecord['kind'] !== 'tool'
    || typeof sourceRecord['callId'] !== 'string'
    || sourceRecord['callId'] === '') {
    throw new Error(`${subject} message must have tool source`)
  }
  const content = messageRecord['content'] as unknown[]
  const block = content[0]
  if (content.length !== 1 || typeof block !== 'object' || block === null
    || (block as Record<string, unknown>)['type'] !== 'tool-result'
    || !Array.isArray((block as Record<string, unknown>)['content'])) {
    throw new Error(`${subject} message must contain one tool-result block`)
  }
  if ((block as Record<string, unknown>)['toolCallId'] !== sourceRecord['callId']) {
    throw new Error(`${subject} message has mismatched tool call ids`)
  }
}
/** The four surface event types whose payload carries an identified message. */
function isMessageEventType(type: unknown): type is SurfaceEventType {
  return type === 'system/message' || type === 'user/message'
    || type === 'assistant/message' || type === 'tool/result'
}
/** Validate fields used directly by restored Session lifecycle logic without replaying the embedded stream. */
function assertAssistantSettlementShape(
  data: Record<string, unknown> | undefined,
  type: 'assistant/attempt' | 'assistant/message',
  index: number,
): void {
  const turn = data?.['turn']
  const step = data?.['step']
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0 || Object.is(turn, -0)
    || typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0 || Object.is(step, -0)
    || !Array.isArray(data?.['stream'])) {
    throw new Error(`seed ${type} at index ${index} has invalid settlement fields`)
  }
}
/** Whether an unknown value carries the current provider/model pair. */
function hasProviderModel(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const pair = value as Record<string, unknown>
  return typeof pair['provider'] === 'string' && pair['provider'].length > 0
    && typeof pair['model'] === 'string' && pair['model'].length > 0
}

/** Validate adapter-default markers imported from a durable request header. */
function assertAdapterDefaults(
  value: unknown,
  config: Record<string, unknown>,
  index: number,
): void {
  if (value === undefined) return
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`seed request/header at index ${index} has invalid adapterDefaults`)
  }
  const defaults = value as Record<string, unknown>
  if (Object.keys(defaults).some(key => !allowedAdapterKeys.has(key))
    || Object.values(defaults).some(marker => marker !== true)
    || defaults['reasoningEffort'] === true && config['reasoningEffort'] === undefined
    || defaults['maxTokens'] === true && config['maxTokens'] === undefined) {
    throw new Error(`seed request/header at index ${index} has invalid adapterDefaults`)
  }
}
const allowedAdapterKeys = new Set(['reasoningEffort', 'maxTokens'])

/** Detach, validate, and freeze the creation metadata published by a session. */
function snapshotSessionHeader(id: SessionId, source?: SessionHeader): SessionHeader {
  const input: unknown = source === undefined
    ? { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false }
    : source
  const snapshot = snapshotJsonValue(input)
  if (snapshot === undefined) throw new Error('session header is not losslessly JSON-serializable')
  return validateSessionHeader(id, snapshot)
}

/**
 * 一个基于事件溯源（Event Sourcing）的会话：
 * 由{@link SessionEvent}构成的仅追加（append-only）事件日志。
 *
 * 普通类（不是Service）——通过`ctx.sessions.create()`创建实时（live）实例，
 * 通过{@link create}创建分离（detached）实例。
 *
 * 使用已有的事件日志进行初始化（Seeding），可以重放（replay）或分叉（fork）一个会话。
 *
 * @typert object
 */
export class Session{
  /** 完整事件记录：用户发消息、模型回答、工具返回结构、轮次开始结束等，都记在这里。*/
  private log: SessionEvent[] = []

  /** 管理“哪些记录目前应该组成对话、按什么顺序排列”。例如历史被压缩厚，让摘要替代旧消息参与后续请求。 */
  private readonly surfaceManager: SurfaceManager // 

  /** 对外提供surfaceManager管理的当前会话视图，通过 session.surface 读取 */
  get surface(): SessionSurface {  // 当前会话（Session）事件日志之上的有序 Surface（表面消息序列）。
    return this.surfaceManager
  }
  /** 会话的基本资料，例如会话ID、格式版本、工作目录、是否从其他会话分出来。*/
  readonly header: SessionHeader

  /** 当前会话开头有多少条记录是从父会话继承的。普通新会话为0 */
  readonly inheritedEventCount: SessionLogOffset

  /** 获取当前会话的唯一标识，实际读取的是 header.id */
  get id(): SessionId{
    return this.header.id
  }

  /** 创建这个对象时，已经带入了多少条旧记录，用来区分“创建时带来的历史”和“之后新增的记录” */
  readonly firstLiveSeq: SessionLogOffset

  /** 缓存一份只读的完整事件列表，避免每次读取都复制。新增事件后，缓存失效 */
  private eventsSnapshot: readonly SessionEvent[] | undefined

  /** 缓存根据日志整理出的最新模型请求头。这里的请求头是自定义的请求配置记录，不是HTTP headers */
  private headerFold: EpochHeader | undefined
  /** 记录请求头已经处理到哪条事件，下次只处理新增记录 */
  private headerFoldSeq = 0

  /** 缓存日志中最近一次记录的模型路由相关信息 */
  private contextFold: RequestContext | undefined
  /** 记录 contextFold 信息已经处理到哪条事件 */
  private contextFoldSeq = 0

  /** 缓存整理好的模型历史消息 */
  private derived: Message[] = []
  /** 记录已经把多少个当前对话节点转换成消息，新增部分可以接着处理 */
  private derivedNodes = 0
  /** {@link SurfaceManager.contentGeneration} 记录消息缓存对应的内容版本；旧内容被替换或修改后，就重新整理缓存 */
  private derivedGeneration = 0

  /**
   * 实际初始化成员、检查历史记录、建立当前对话状态。private类型，外部不能直接new Session()
   * @param id 会话 ID
   * @param seed 初始化时带入的旧事件
   * @param header 会话基本资料
   * @param mode 决定历史数据如何接收：复制成快照，或者按恢复流程提供的数据状态接收
   * @param suppliedInheritedEventCount 调用方提供的父会话继承事件数量
   * @param projections 消息处理规则，默认没有额外规则
   */
  private constructor(
    id: SessionId,
    seed?: readonly SessionEvent[],
    header?: SessionHeader,
    mode: 'snapshot' | SessionSeedEventState = 'snapshot',
    suppliedInheritedEventCount?: SessionLogOffset,
    projections: readonly SessionMessageProjection[] = [],
  ){
    // 准备对象：新会话surfaceManager和聊天内容管理器restoredHeader
    this.surfaceManager = new SurfaceManager(this.log, SessionLogOffset(0), projections)
    const restoredHeader = mode === 'snapshot' ? undefined : validateRestoredSessionHeader(id, header)

    // 旧数据处理：逐条检查后放进当前会话
    if (seed !== undefined){
      for (const [index, source] of seed.entries()) {
        const snapshot = mode == 'snapshot' ? snapshotJsonValue(source) : source
        if (snapshot == undefined){
          throw new Error(`seed event at index ${index} is not losslessly JSON-serializable`)
        }
        assertSessionEventEnvelope(snapshot, index)
        if (snapshot.seq !== index) {
          throw new Error(`seed event at index ${index} has seq ${snapshot.seq} (expected ${index}); seed must be contiguous from 0`)
        }

        try {
          this.surfaceManager.validateNext(snapshot)
        } catch (error: unknown) {
          throw new Error(`invalid seed event at index ${index}: ${error instanceof Error ? error.message : 'invalid surface metadata'}`)
        }
        this.log.push(mode === 'snapshot' ? deepFreeze(snapshot) : snapshot)
      }
    }

    // 旧记录数量记录
    this.firstLiveSeq = SessionLogOffset(this.log.length)

    // 保存会话资料
    this.header = restoredHeader ?? snapshotSessionHeader(id, header)

    // 分支会话处理
    if (this.header.isSeeded && seed === undefined) {
      throw new Error('seeded session requires an explicit constructor seed')
    }
    if (this.header.isSeeded && suppliedInheritedEventCount === undefined) {
      throw new Error('seeded session requires an inherited event count')
    }
    const inheritedEventCount = SessionLogOffset(suppliedInheritedEventCount ?? 0)
    if (!this.header.isSeeded && inheritedEventCount !== 0) {
      throw new Error('unseeded session inherited event count must be 0')
    }
    if (inheritedEventCount > this.log.length) {
      throw new Error('session inherited event count exceeds its event log')
    }
    if (mode === 'snapshot' && this.header.isSeeded && inheritedEventCount !== this.log.length) {
      throw new Error('seeded session constructor seed must equal its inherited prefix')
    }
    this.inheritedEventCount = inheritedEventCount

    
    if (seed !== undefined && mode === 'snapshot' && this.header.isSeeded) {
      this.append('session/end-seed', { inherited: true })  // 旧记录标记
    } else if (seed !== undefined && this.log.at(-1)?.type !== 'session/end-seed') {
      this.append('session/end-seed', {})  // 新分支会话注明
    }
    
  }

  /**
   * 创建一个独立的会话对象，也可以传入历史记录。它会复制、校验并冻结传入的数据，避免外部修改影响会话。
   * @param id 给这个会话指定唯一ID
   * @param seed 可选择的历史事件。不传就是没有历史的新会话
   * @param header 会话基本资料，例如工作目录、格式版本、来源信息。不传会生成基本资料
   * @param inheritedEventCount 开头有多少条事件继承自父会话。创建分支会话时使用
   * @param projections 插件提供的消息处理规则，用来解释插件记录的消息变更
   * @returns 一个Session对象。传入的历史和资料会经过校验、复制，避免被外部修改
   */
  static create(
    id: SessionId,
    seed?: readonly SessionEvent[],
    header?: SessionHeader,
    inheritedEventCount?: SessionLogOffset,
    projections?: readonly SessionMessageProjection[]
  ): Session {
    return new Session(id,seed,header,'snapshot',inheritedEventCount,projections)
  }

  /**
   * 根据恢复流程提供的历史数据重建会话，避免对已经按要求准备好的数据重复复制。
   * @param id 要恢复的会话 ID
   * @param seed 已经读取出来的历史事件
   * @param header 已经读取出来的会话基本资料
   * @param inheritedEventCount 历史中有多少条事件最初继承自父会话
   * @param eventState 说明这批历史数据是否已独立持有或已深度冻结，帮助恢复过程避免重复复制
   * @param projections 解释插件自定义消息变更所需的规则
   * @returns 恢复后的Session对象
   */
  static fromRestore(
    id: SessionId,
    seed: readonly SessionEvent[],
    header: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    eventState: SessionSeedEventState,
    projections?: readonly SessionMessageProjection[],
  ): Session {
    return new Session(
      id,
      seed,
      header,
      eventState,
      inheritedEventCount,
      projections,
    )
  }

  /**
   * 判断某条已有记录是否属于当前会话自身，而不是继承自父会话。
   * @param seq 要检查的事件编号
   * @returns true，事件存在且不属于父会话继承的部分；false，事件属于继承部分或者编号不存在。
   */
  isOwnSeq(seq: SessionSeq): boolean {
    return seq >= this.inheritedEventCount && seq < this.seq
  }

  /**
   * 下一条事件的编号，也等于目前已有的事件数量
   * @returns 下一条事件的编号，从 0 开始。
   */
  get seq(): SessionLogOffset {
    return SessionLogOffset(this.log.length)
  }

  /**
   * 往会话追加一条事件，自动分配编号和事件，检查数据，并通知观察者。
   * @param type 发生了什么，例如'user/message'、'turn/start'
   * @param data 这件事的具体内容。不同事件类型要求不同的数据
   * @param opts 对产生消息的事件，说明这条消息怎样进入当前对话。普通运行事件不传。...opts 实际上表示：根据事件类型，接收零个或一个配置对象
   * @returns 已追加到日志的事件，包含自动分配的编号、时间，以及复制并冻结后的事件数据。
   */
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []
  ): SessionEvent<T> {
    // 获取消息加入对话的相关配置
    const surfaceOpts: SurfaceIntent | undefined = opts[0]
    const surfaceMetadata = {
      ...surfaceOpts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: surfaceOpts.sourceEventSeqs },
      ...surfaceOpts?.surfaceOp === undefined ? {} : { surfaceOp: surfaceOpts.surfaceOp },
    }
    
    // 复制并检查传入的数据
    const dataSnapshot = snapshotJsonValue(data)
    if (dataSnapshot === undefined) {
      throw new Error(`session event "${type}" carries non-JSON-serializable data`)
    }
    const surfaceMetadataSnapshot = snapshotJsonValue(surfaceMetadata)
    if (surfaceMetadataSnapshot === undefined) {
      throw new Error(`session event "${type}" carries non-JSON-serializable surface metadata`)
    }

    // 防止追加过程中嵌套追加
    const entry = attachments.get(this)
    if (entry?.appending) {
      throw new Error('session append cannot reenter while another append is being published')
    }

    // 组装完整事件
    const event = deepFreeze({
      type,
      seq: SessionSeq(this.log.length),
      time: Date.now(),
      data: dataSnapshot,
      ...(surfaceMetadataSnapshot as { surfaceOp?: unknown; sourceEventSeqs?: unknown }),
    } as unknown as SessionEvent<T>)

    // 检查事件是否合法
    validateSessionEventData(event, `session event "${type}" at seq ${event.seq}`)
    this.surfaceManager.validateNext(event as SessionEvent)

    if (entry !== undefined) entry.appending = true
    try {
      let callbacks: SessionCallback[] | undefined
      const callbackArgs: unknown[] = [this, event]
      if (entry !== undefined) {
        callbacks = collectSessionCallbacks(entry.emitCtx, [entry.carrier, 'session/event', ...callbackArgs])
      }
      // 加入日志，清除旧缓存
      this.log.push(event as SessionEvent)
      this.eventsSnapshot = undefined
      
      // 通知插件，返回事件
      if (callbacks !== undefined && entry !== undefined) {
        invokeContainedSessionObservers(entry.emitCtx, 'session/event', entry.id, callbackArgs, callbacks)
      }
      return event
    } finally {
      if (entry !== undefined) {
        entry.appending = false
        if (entry.detachRequested && !entry.announcing) entry.detach()
      }
    }
  }

  /**
   * 从日志中整理出当前生效的模型请求配置，供下一次请求比较和使用
   * @returns 折叠后的请求头；如果当前还不存在请求头事件，则为 undefined。
   */
  requestHeader():EpochHeader | undefined {
      if (this.headerFoldSeq < this.log.length) {
      // Frozen on update: the fold is session state exposed by reference — a
      // consumer mutating it in place (instead of building a replacement)
      // would desync every later comparison against the log, so mutation
      // throws instead.
      this.headerFold = deepFreeze(foldRequestHeader(this.log.slice(this.headerFoldSeq), this.headerFold))
      this.headerFoldSeq = this.log.length
    }
    return this.headerFold
  }

  /**
   * 获取最近一次记录的模型路由相关信息；还没记录过时返回undefined。
   * @returns 最新的不可变路由数据
   */
  requestContext(): RequestContext | undefined {
    if (this.contextFoldSeq < this.log.length) {
      for (const event of this.log.slice(this.contextFoldSeq)) {
        if (event.type === 'request/context') this.contextFold = deepFreeze({ ...event.data })
      }
      this.contextFoldSeq = this.log.length
    }
    return this.contextFold
  }

  /**
   * 整理出当前应该发给模型的历史消息列表。不会把所有事件原封不动发过去。
   */
  deriveMessages(): Message[]{
    // 获取当前参与对话的事件编号，以及内容版本号
    const surface = this.surface
    const nodes = surface.nodes
    const generation = surface.contentGeneration

    // 如果之前的内容被替换或修改，旧缓存不能再用，需要重新整理
    if (generation !== this.derivedGeneration) {
      this.derived = []
      this.derivedNodes = 0
      this.derivedGeneration = generation
    }

    // 把未处理事件转换成消息，加入缓存
    for (const seq of nodes.slice(this.derivedNodes)) {
      const msg = this.deriveEventMessage(this.log[seq]!)
      // 跳过，事件转换后无消息内容
      if (msg) this.derived.push(msg)
    }
    // 更新处理进度
    this.derivedNodes = nodes.length
    return [...this.derived]
  }

  /**
   * 把一条事件转换成消息；如果该事件不产生消息，就返回null。
   * @param event 要转换的那一条会话事件
   * @returns 能产生消息，返回一个Message；不能产生消息，返回一个null
   */
  deriveEventMessage(event: SessionEvent): Message | null {
    return this.surfaceManager.deriveEventMessage(event)
  }

}


type SessionCallback = (...args: unknown[]) => unknown