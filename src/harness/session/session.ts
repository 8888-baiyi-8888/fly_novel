import type { Message } from '@fly-novel/llm'
import { deepFreeze, snapshotJsonValue } from '@fly-novel/util'
import { SessionLogOffset, SessionSeq } from './types/index.ts'
import type {
  EpochHeader, RequestContext, SessionEvent, SessionEventMap, SessionEventType,
  SessionHeader, SessionId, SessionSeedEventState, SurfaceEventType, SurfaceIntent,
} from './types/index.ts'
import { SurfaceManager } from './surface/index.ts'
import type { SessionSurface, SessionMessageProjection } from './surface/index.ts'
import { foldRequestHeader } from './request-header.ts'
import { snapshotSessionHeader, validateRestoredSessionHeader } from './validation/header.ts'
import { assertSessionEventEnvelope } from './validation/event.ts'
import { validateSessionEventData } from './validation/event-data.ts'
import { attachments, collectSessionCallbacks, invokeContainedSessionObservers } from './session-observers.ts'
import type { SessionCallback } from './session-observers.ts'

/**
 * 基于仅追加事件日志的会话，负责历史恢复、事件追加和模型消息派生。
 * 通过 {@link Session.create} 创建独立实例，通过 {@link Session.fromRestore} 接收恢复数据。
 * 初始化时可传入已有事件日志，用于重放或分叉会话。
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

  /**
   * 按事件编号读取日志中的一条记录，不复制事件。
   * @deprecated 为已有调用保留；新逻辑应读取已维护的状态，避免同步查询任意历史事件。
   * @param seq 要读取的事件编号
   * @returns 对应的事件；编号不存在时返回 undefined
   */
  eventAt(seq: SessionSeq): SessionEvent | undefined {
    return this.log[seq]
  }

  /**
   * 获取指定范围的只读事件快照，包含起始位置，不包含结束位置。
   * 完整快照在追加事件前重复使用；后续追加不会改变已经返回的快照。
   * @deprecated 为已有调用保留；新逻辑应读取已维护的状态，避免同步查询任意历史事件。
   * @param fromSeq 起始偏移量，默认从日志开头读取
   * @param toSeqExclusive 结束偏移量，不包含该位置，默认读取到当前日志末尾
   * @returns 已冻结的事件数组，按日志顺序排列，事件本身沿用日志中的记录
   */
  snapshotEvents(
    fromSeq: SessionLogOffset = SessionLogOffset(0),
    toSeqExclusive: SessionLogOffset = this.seq,
  ): readonly SessionEvent[] {
    if (fromSeq === 0 && toSeqExclusive === this.log.length) {
      this.eventsSnapshot ??= Object.freeze([...this.log])
      return this.eventsSnapshot
    }
    return Object.freeze(this.log.slice(fromSeq, toSeqExclusive))
  }

  /**
   * 获取当前会话自身的事件，跳过从父会话继承的事件前缀。
   * @deprecated 为已有调用保留；新逻辑应读取已维护的状态，避免同步查询任意历史事件。
   * @returns 按日志顺序排列的只读事件快照，包含继承边界之后的会话标记和新增事件
   */
  ownEvents(): readonly SessionEvent[] {
    return this.snapshotEvents(this.inheritedEventCount)
  }

}
