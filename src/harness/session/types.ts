import {Branded, JsonValue,BrandedNumber,brandNumber} from '@fly-novel/util'
import {
  UserMessage,
  SystemMessage,
  AssistantMessage,
  AssistantStreamRecord,
  TokenUsage,
  ToolCallId,
  ToolResultMessage,
  LlmCallConfig,
  ToolSchema,
  LlmCallConfigAdapterDefaults,
  SystemPromptUpdate,
  LlmFailure
} from '@fly-novel/llm'
/**
 * 为字符串添加编译期品牌标记，不改变其值。
 * @param value - 由目标品牌所属领域接纳的字符串。
 * @returns 带有所需编译期品牌标记的原字符串。
 */
export function brandString<T extends Branded<string>>(value: string | T): T {
  return value as T
}
/** 可持久化的取消原因，也包括原始记录未提供原因的导入数据。 */
export type TurnEndCancelCause = AgentCancelCause | { readonly kind: 'legacy' }

/** 正在运行的 Agent 驱动器被取消的原因。 */
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

/**
 * 轮次结束的原因，可通过声明合并扩展的联合类型映射。
 */
export interface TurnEndReasonMap {
  completed: { kind: 'completed' }
  /** 取消请求中断了正在进行的轮次。 */
  aborted: { kind: 'aborted'; reason: TurnEndCancelCause }

  blocked: { kind: 'blocked' }
  /**
   * 轮次失败。error 始终为结构化失败：原样保留 LlmError 的事实，或将其他错误展开为 { message: errorChain(error), code: 'UNKNOWN' }。
   */
  error: { kind: 'error'; error: LlmFailure }
  /** 至少一个步骤达到输出 Token 上限，即使插件随后继续了该轮次。 */
  'max-tokens': { kind: 'max-tokens' }
  /**
   * 为崩溃后遗留的未结束轮次补记结束状态：agent-loop 恢复时向末轮未结束的日志追加此标记，session-query 在冷读取时合成它。循环在实时运行中不会产生此标记，崩溃前记录的事件保持不变。
   */
  interrupted: { kind: 'interrupted' }
}
/** {@link TurnEndReasonMap} 所有变体组成的联合类型，表示轮次结束原因；插件通过向映射合并变体扩展它。 */
export type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap]
/**
 * 会话事件进入有序消息视图的方式，仅适用于 {@link SurfaceEventType} 事件。
 * - 'append'：追加到末尾，是用户、助手和工具消息的常规路径。
 * - { op: 'replace', startSeq, endSeq }：用本节点替换从 startSeq 到 endSeq 的视图节点，包含两端。
 * 两个端点都必须存在于当前视图；startSeq === endSeq 时只替换一个节点。
 * 本节点的 {@link SessionEvent.sourceEventSeqs} 必须包含所有被遮蔽的视图节点。
 * 此操作用于压缩，也可供其他替换消息视图的生产者使用。
 */
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }

/**
 * {@link Session.append} 使用的视图位置操作和源事件引用序号；消息事件必须提供，仅日志事件禁止提供。
 */
export type SurfaceIntent<T extends SurfaceEventType = SurfaceEventType> = {
  surfaceOp: SurfaceOp
} & (T extends 'assistant/message' ? {
  /** 助手消息内嵌供应商响应流，而不引用源事件。 */
  sourceEventSeqs?: never
} : {
  /** 已知的较早源事件序号组成的完整非空集合。 */
  sourceEventSeqs?: SessionSeq[]
})

/**
 * {@link SessionEventType} 中可生成 LLM 消息并进入有序视图的事件子集。只有这些事件可携带 {@link SurfaceOp}；系统、用户和工具事件还可通过 {@link SessionEvent.sourceEventSeqs} 引用较早的源事件。
 */
export type SurfaceEventType =
  | 'system/message'
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'

/** 携带必要视图操作的消息事件。 */
export type SurfaceEvent = SessionEvent<SurfaceEventType>

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
 * 记录在日志中、但不属于派生消息历史的请求状态：调用配置与工具。系统提示词属于派生历史，对应视图第 0 个节点的 system/message 事件。最新的完整 request/header 快照用于重建请求头；规范形式中不保留空的可选字段。
 */
export interface EpochHeader {
  /** 会话的调用配置，包括供应商、模型、推理强度和采样参数。 */
  config: LlmCallConfig
  /** 由实际适配器确定的生效配置字段，而非调用方提出的配置值。 */
  adapterDefaults?: LlmCallConfigAdapterDefaults
  /** 组装后的工具模式；请求不使用工具时省略。 */
  tools?: ToolSchema[]
}

/** 绑定到注册实例的已解析模型路由元数据。 */
export interface RequestContext {
  /** 此元数据所属的已注册供应商路由。 */
  provider: string
  /** 此元数据所属、由供应商定义的模型标识。 */
  model: string
  /** 模型声明的请求与响应合计上下文上限，单位为 Token。 */
  contextWindow?: number
  /** 若路由将任意位置的最新 system 消息视为生效系统提示词，则为 'in-history'。 */
  systemPromptUpdate?: SystemPromptUpdate
}

/**
 * 说明为什么会追加（append）一个 `request/header` 快照：
 *
 * `'initial'` —— 日志中的第一个 Header，
 * 表示一个新的会话（new conversation）。
 *
 * `'resume'` —— 当前 Loop 实例第一次发起请求时，
 * 日志中已经存在 Header 事件；
 * 例如：进程重启（process restart）、Fork Seed（分叉种子）。
 *
 * `'change'` —— 后续请求使用了不同的 Header；
 * 如果此时恰好也发生了消息系列（series）边界变化，
 * 则通过 `startsSeries` 保留这一系列边界。
 *
 * `'series'` —— Header 本身没有发生变化，
 * 但显式开始了一个不同的消息系列（message series），
 * 或者发生在一次 Surface Replacement（表面消息替换）之后。
 */
export type RequestHeaderReason = 'initial' | 'resume' | 'change' | 'series'

/**
 * Agent 一次交互过程中支持合并扩展（merge-extensible）、
 * 仅追加（append-only）的事实来源（source of truth）。
 *
 * 消息历史（Message History）由这份日志派生得到。
 * 每一个事件都使用无损 JSON（lossless JSON）保存，
 * 并且事件序列号始终保持连续。
 *
 * Assistant 的尝试事件（attempt events）会嵌入其精确的、
 * 经过紧凑化处理的原始流（raw streams），
 * 因此持久化层可以为每一次尝试保存一个持久且确定的最终结果（settlement）。
 */
export interface SessionEventMap {

  /**
   * 在 Loop 获取排队中的输入（queued input）或执行 pre-step 之前，
   * 开启编号为 `turn` 的轮次（Turn）。
   *
   * 如果发生拒绝、空输入、取消或失败，
   * 这个 Turn 可能在没有进入任何 Step 的情况下直接结束；
   *
   * 否则，后续带有标识的 `user/message` 事件或消息批次，
   * 会记录进入该 Step 的消息。
   */
  'turn/start': { turn: number }

  /**
   * 结束编号为 `turn` 的轮次，
   * 并通过 {@link TurnEndReason} 记录导致该轮次结束的原因。
   *
   * 如果一个 Turn 从未进入 Step，
   * 那么它不会存在 `step/start` 或 `step/end`。
   *
   * Loop 在 Turn 边界不会等待 flush（刷新/持久化写入）完成：
   * `dsh-session-checkpoint-policy`
   * 负责每个请求（per-request）的持久化检查点（durability checkpoint）。
   *
   * 而在 `whenIdle()` 之后读取存储的消费者（consumer），
   * 需要自行执行 flush。
   *
   * 成功（Success）会提交（commit）这个 Turn；
   * 拒绝（Rejection）则会实时报告，
   * 但不会阻止后续工作继续进行。
   */
  'turn/end': {
    turn: number
    reason: TurnEndReason
  }

  /**
   * 开启 Turn `turn` 中编号为 `step` 的步骤（Step）。
   *
   * 一个 Step = 一次模型调用（model call）
   * + 该模型调用所请求执行的工具（tool executions）。
   */
  'step/start': {
    turn: number
    step: number
  }

  /**
   * 结束 Turn `turn` 中编号为 `step` 的步骤（Step）。
   */
  'step/end': {
    turn: number
    step: number
  }

  /**
   * 模型可见表面（model-visible surface）上的一条用户角色消息。
   *
   * 它可能来自以下三种来源：
   *
   * 1. 人类用户直接输入的 Prompt
   *    —— 即当前 Turn 从队列中获取的消息；
   *
   * 2. 通过 `agent.inject()` 注入的合成上下文（synthetic context），
   *    例如：
   *    - 文件变更通知
   *    - 子目录中的 AGENTS.md
   *    - Skill 内容
   *    - Cron 定时任务通知
   *    - ……
   *
   * 3. 已进入的 Goal continuation round（目标继续轮次）。
   *
   * 这三种来源都会原样投影（verbatim project）其 `content`；
   * `source` 字段用于区分它们的来源。
   */
  'user/message': UserMessage

  /**
   * 模型可见表面上的、已经渲染完成的系统提示词（System Prompt）。
   *
   * Loop 会在当前 Step 的第一条 `user/message` 之前，
   * 将第一个 System Prompt 追加为 Surface Node 0。
   *
   * 对于一个已经准备好的、位于历史记录中的路由（prepared in-history route），
   * 如果仍属于同一个连续系列（continuing series），
   * 可以继续追加非空的 System Prompt 变更。
   *
   * 如果当前路由不具备这种能力，
   * 或者已经进入新的消息系列（new series），
   * 则会把文本规范化（normalize）到第一个 System Node。
   *
   * 规范化过程中：
   * 会先清空后续非空节点，
   * 然后在需要时重写头节点（head），
   * 整个过程通过日志中记录的逐节点替换（per-node replacements）完成。
   *
   * 如果渲染结果为空，
   * 则始终清除所有当前活跃的 System Node，
   * 从而确保旧的系统指令不再对模型可见。
   *
   * 后续的空节点处于休眠状态（dormant），
   * 不会投影成任何消息；
   *
   * 如果头节点为空，并且没有其他活跃的后续节点，
   * 则表示“当前没有 System Prompt”。
   *
   * 恢复出来的非空文本同样遵循上述路由规则和系列规则；
   * 空节点永远不会使旧文本重新恢复。
   */
  'system/message': {
    turn: number
    step: number
    message: SystemMessage
  }

  /**
   * 某个 Step 最终组装完成的 Assistant 消息。
   *
   * 派生消息历史（derived history）会使用这条事件。
   *
   * 如果 Adapter 返回了 Token 用量统计，
   * 则该事件还会携带当前 Step 的 `usage`，
   * 从而让模型输出和对应的 Token 统计保存在一起。
   *
   * 不存在单独的 usage 事件。
   *
   * 如果 Adapter 没有报告 Token 使用情况，
   * 则 `usage` 字段不存在。
   *
   * 如果一个 Turn 在流式输出过程中被取消，
   * 已经发送出来的文本 / 推理内容前缀，
   * 仍然会被最终保存为这条事件，
   * 同时设置：
   *
   * `interrupted: true`
   *
   * 尚未分发执行的 Tool Call 不会包含其中。
   *
   * 这个标记可以直接说明该 Assistant Message 是一个被中断的前缀，
   * 而不需要再通过 Turn 边界重新推导是否发生过中断。
   *
   * 如果一个被中止（aborted）的 Turn 完全不存在该事件，
   * 则说明它没有流式输出任何模型可见内容。
   */
  'assistant/message': {
    turn: number
    step: number
    message: AssistantMessage

    /**
     * 精确的、带时间信息的模型输出流。
     *
     * 进行紧凑化（compacted）保存，
     * 但不会把各个 Delta 的边界合并掉。
     */
    stream: AssistantStreamRecord[]

    usage?: TokenUsage

    interrupted?: true
  }

  /**
   * 一次没有提交任何 Surface Message 的模型尝试（model attempt）。
   *
   * 内嵌的 stream 会保存一次：
   *
   * - 失败（failed）
   * - 重试（retried）
   * - 取消（cancelled）
   * - 流错误（stream-error）
   *
   * 等已经到达最终状态（settlement）的模型尝试。
   *
   * 这样既可以完整保存模型尝试过程，
   * 又不需要伪造一条模型可见的历史消息。
   */
  'assistant/attempt': {
    turn: number
    step: number
    stream: AssistantStreamRecord[]
  }

  /**
   * 模型请求执行一次工具调用（Tool Invocation）。
   *
   * `name` 表示工具名称；
   *
   * `arguments` 保存模型生成的原始 JSON 字符串，
   * 完全按照模型生成时的形式保存，不进行解析（unparsed）。
   *
   * `callId` 用于将本次工具调用
   * 与对应的 `tool/result` 进行配对。
   */
  'tool/call': {
    turn: number
    step: number
    callId: ToolCallId
    name: string
    arguments: string
  }

  /**
   * 一次已经完成的 Tool Call 的结果。
   *
   * 其中包括：
   *
   * - 面向模型（model-facing）的工具结果
   * - 可选的内部失败标识（failure identity）
   * - 可选的面向用户的失败原因（user-facing reason）
   * - 可选的工具私有 `meta` 展示数据
   *
   * `reason` 保存在模型可见消息之外，
   * 不会进入模型内容。
   *
   * Core（核心系统）不会理解 `meta` 的内部结构，
   * 它对 Core 来说是不透明的（opaque）。
   *
   * 生成该 `meta` 的 Tool 自己负责定义其结构，
   * 并在 `presentResult` 中重新读取它。
   *
   * 但是 `meta` 必须可以被 JSON 序列化。
   *
   * `Session.append()` 会通过 `isJsonValue`
   * 在运行时校验所有 Event Data。
   *
   * 因此，如果 `meta` 无法进行 JSON 序列化，
   * 会直接在数据源头被拒绝。
   *
   * 这样持久化日志在 Replay（重放）时，
   * 就可以重新生成完全相同的展示卡片（card）。
   *
   * 如果 Tool 没有主动附加 `meta`，
   * 那么该字段不存在。
   *
   * 例如：
   * `dsh-tool-fs` 会在这里保存工具执行结果产生时的
   * 上下文 Diff（contextual diff）。
   */
  'tool/result': {
    turn: number
    step: number
    message: ToolResultMessage

    /**
     * 可选的失败标识以及原始的面向用户的失败原因。
     *
     * 它们位于模型内容之外。
     *
     * 只有当 Tool Result Block 中：
     *
     * `isError: true`
     *
     * 时，才允许存在该字段。
     */
    error?: {
      name: string
      code: string
      reason?: string
    }

    meta?: JsonValue
  }

  /**
   * 下一次请求（next request）的完整 Header。
   *
   * 它会在请求真正发送（dispatch）之前，
   * 在对应 Step 内被追加到日志。
   *
   * 该事件只存在于日志（log-only）中；
   * 最新的 Snapshot 会使用它重建请求 Header。
   */
  'request/header': {
    header: EpochHeader
    reason: RequestHeaderReason

    /**
     * Header 发生变化时，
     * 同时意味着一个新的、独立的模型消息系列（model-message series）开始。
     */
    startsSeries?: true
  }

  /**
   * 下一次请求的路由元数据（Route Metadata）。
   *
   * 只有在以下内容发生变化时才会记录：
   *
   * - Route（路由）
   * - Capacity（容量）
   * - System Prompt Update Mode（系统提示词更新模式）
   *
   * 它不会参与：
   *
   * - Request Reconstruction（请求重建）
   * - Header Equality（Header 相等性判断）
   *
   * Prompt 是否能够被接纳（Prompt Admission），
   * 使用的是当前已经绑定的 Prepared Call 的能力，
   * 而不是之前某次请求保存下来的这个 Snapshot。
   */
  'request/context': RequestContext

  /**
   * 标记构造函数 Seed（种子数据）的结束位置。
   *
   * 位于该事件之前的所有事件都有更小的 seq，
   * 并且全部来自 Seed，例如：
   *
   * - Resume（恢复）
   * - Fork（分叉）
   * - Replay（重放）
   *
   * 当前这个 Session 生命周期并没有生成这些事件。
   *
   * 这是一个仅存在于日志中的事件（log-only event），
   * 它是 {@link Session.firstLiveSeq} 的持久化表示（durable projection）。
   *
   * ----------------------------------------------------------------
   *
   * 一个新创建的 Fork 子 Session，
   * 会在其精确的继承前缀截断位置
   * 拥有一个：
   *
   * `{ inherited: true }`
   *
   * 的标记。
   *
   * 即使该继承前缀本身结束于祖先 Session 的 marker，
   * 这个规则仍然成立。
   *
   * 最后一个带 `inherited` 标记的 marker，
   * 表示当前 Session 自己的继承截断位置（cut）。
   *
   * 没有 `inherited` 标记的 marker，
   * 则继续表示普通的 Restore / Replay 生命周期边界。
   *
   * ----------------------------------------------------------------
   *
   * `Session` 的构造函数是唯一合法的写入者。
   *
   * 与之配套的 invariant（不变量检查）在这里故意没有施加限制。
   *
   * 因此，如果某个 Plugin 自行追加了这个事件，
   * 那么位于它之前的所有 Live 区间，
   * 都会被静默地错误分类成 Seed History。
   *
   * ----------------------------------------------------------------
   *
   * 对于一个独立 open/close 区间的拥有者，例如：
   *
   * `compaction/start`
   *       ...
   * `compaction/end`
   *
   * 它需要读取这个事件。
   *
   * 原因是：
   * Seed History 和当前生命周期产生的 Live Work，
   * 在其他方面可能完全字节一致（byte-identical）。
   *
   * 因此，如果一个尚未匹配 closing marker 的 opening marker
   * 位于这个事件之前，
   * 那么这个 opening marker 属于一个已经结束的生命周期，
   * 无论那个生命周期最终是以什么方式结束的。
   *
   * 注意：
   * 这并不是其他 Writer 是否仍然存活的信号（liveness signal）。
   *
   * 一个并发运行的 Session 会在其他位置维护自己的生命周期边界。
   *
   * 因此，如果需要支持多个 Writer 并发写入，
   * 仅靠这份日志还不够，
   * 需要额外的并发存活信号。
   */
  'session/end-seed': {
    inherited?: true
  }
}

/**
 * {@link SessionEventMap} 中所有可以被追加（append）的事件类型 Key。
 *
 * 其中也包括由 Plugin 通过声明合并（plugin-merged）
 * 扩展进来的事件类型。
 */
export type SessionEventType = keyof SessionEventMap

/**
 * 将数值接纳为已有会话事件的位置。
 * @param value - 由所属日志操作接纳的非负安全整数。
 * @returns 带有会话事件序号品牌标记的原数值。
 */
export function SessionSeq(value: number): SessionSeq {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`)
  }
  return brandNumber<SessionSeq>(value)
}
/**
 * 会话日志中的一条不可变记录
 *
 * 这是一个基于`type`字段构建的真正的可辨识联合类型（discriminated union），而不是彼此独立的`type`/`data`联合类型。
 * 因此，通过`switch(event.type)`判断事件类型时，TypeScript可以自动收窄（narrow）`event.data`的类型，而无需进行类型断言（cast）。
 *
 * {@link sourceEventSeqs} 和{@link sufaceOp}字段是条件存在的：
 * 它们只会存在于{@link SurfaceEventType}类型的变体中（`system/message`、`user/message`、`assistant/message`、`tool/result`）。
 *
 * 非Surface事件（例如边界标记、尝试记录、错误）永远不会携带Surface元数据（surface metadata）—— 编译器会在`Session.append()`的调用位置强制执行这一约束。
 */
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]:{
    type:K
    seq:SessionSeq  // 会话内部单调递增的序列号
    time: number  // Ubix时间戳，单位为毫秒
    data: SessionEventMap[K]

    /**
     * 用于标记：当前读取器（reader）无法识别该事件的`type`时，是否可以安全地跳过这个事件。
     *
     * 如果该字段不存在，则表示该事件是“必须的（required）”：
     * 当读取器遇到一个无法识别的事件类型，并且该事件没有此标记时，
     * 读取器必须拒绝重建（reconstruct）该会话，而不能直接静默丢弃这个事件。
     *
     * 这是因为，一个无法识别但又属于必须类型的事件，可能会改变后续整个事件日志的解释方式。
     *
     * 写入器（writer）只有在记录属于纯信息性记录（purely informational records），
     * 并且该记录即使丢失也不会影响会话重建时，才会将该字段设置为`true`。
     *
     * 默认该事件视为“必须的”，意味着：
     * 如果开发者忘记添加该标记，系统最多只是过于谨慎地拒绝恢复会话（这会造成一些不便），
     * 而不会在缺失关键事件的情况下，静默恢复一个内容已经残缺的会话。
     */
    ignorable?: true
  }&(
    K extends SurfaceEventType
      ? SurfaceIntent<K>
      :{
        surfaceOp?: never
        sourceEventSeqs: never
      }
  )
}[T]

/**
 * 当前会话逻辑格式版本，写入每个新建的 {@link SessionHeader}。
 * 会话与持久化代码只接纳此版本；仅读取头部的读取器识别受支持的历史格式，读取事件体时组合构建期确定的相邻迁移链，在构造 Session 前统一转换到当前版本。
 * 版本号为单调递增整数，不区分主次版本。是否升级由写入器的输出决定，而非新读取器能接纳什么：当旧运行时无法语义完整地处理新日志时必须升级。
 * 仅能解析而不报错并不代表正确；静默跳过影响重建的内容属于错误读取。
 * 达到升级条件的是结构变化：头部结构、{@link SessionEvent} 信封、核心事件语义或消息视图机制（{@link SurfaceEventType} 集合和 {@link SurfaceOp} 变体）。
 * 新增普通事件类型不提升格式版本，其兼容性由每个事件的 {@link SessionEvent.ignorable} 控制。
 * 无法确定时应提升版本：接近恒等转换的迁移成本很低，漏升版本却会让旧运行时静默误读新日志。
 * 已发布迁移、不可变旧版本及当前版本快速路径的规则记录在：
 * .agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md。
 */
export const SESSION_FORMAT_VERSION = 3

/**
 * 已校验的不可变存储元数据，保存在会话事件日志之外。
 */
export interface SessionHeader {
  /**
   * 当前逻辑格式版本，取自 {@link SESSION_FORMAT_VERSION}。历史物理头部在进入此接口前完成转换。
   */
  readonly version: typeof SESSION_FORMAT_VERSION
  /** 会话标识，与 {@link Session} 的标识一致。 */
  readonly id: SessionId
  /** 会话创建时的 Unix 时间戳，以毫秒为单位，必须为非负安全整数。 */
  readonly createdAt: number
  /** 创建会话时的绝对工作目录，如有。 */
  readonly cwd?: string
  /** 本会话分叉所来源的父会话，用于记录种子继承关系，如有。 */
  readonly parentSession?: SessionId
  /**
   * 会话是否包含通过分叉继承的事件前缀。精确前缀长度属于会话状态，不属于普通头部元数据。
   */
  readonly isSeeded: boolean
  /**
   * 作为子 Agent 子会话创建时的粗粒度产品分类；仅用于展示，不能证明子会话可继续执行。
   */
  readonly origin?: 'subagent'
  /**
   * 委派深度：顶层会话省略，视为 0；子 Agent 会话为父级深度加 1。持久化此值可让递归预算跨重启与恢复保留，否则恢复的子会话会被误置为顶层。
   */
  readonly delegationDepth?: number
  /**
   * 按会话组装 Agent 的部署中，本会话使用的 Agent 预设标识。预设决定工具和提示词，因此必须持久化；恢复时若采用不同组装，模型可能无法继续处理重放的历史。
   */
  readonly agentPreset?: string
}
/**
 * 将数值接纳为会话日志偏移量。
 * @param value - 表示间隙位置或前缀长度的非负安全整数。
 * @returns 带有会话日志偏移量品牌标记的原数值。
 */
export function SessionLogOffset(value: number): SessionLogOffset {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionLogOffset must be a non-negative safe integer, got ${String(value)}`)
  }
  return brandNumber<SessionLogOffset>(value)
}

/**
 * Aliasing state of an adoptable Session seed. `shared-frozen` permits deeply
 * frozen aliases plus independently owned unfrozen values in the same seed.
 */
export type SessionSeedEventState = 'detached' | 'shared-frozen'