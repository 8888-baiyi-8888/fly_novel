import type { JsonValue } from '@fly-novel/util'
import type {
  UserMessage, SystemMessage, AssistantMessage, AssistantStreamRecord,
  TokenUsage, ToolCallId, ToolResultMessage, LlmFailure,
} from '@fly-novel/llm'
import type { SessionSeq } from './identifiers.ts'
import type { EpochHeader, RequestContext, RequestHeaderReason } from './headers.ts'

export { brandString, SessionId, SessionSeq, SessionLogOffset } from './identifiers.ts'
export type { SessionSeqCursor } from './identifiers.ts'
export { SESSION_FORMAT_VERSION } from './headers.ts'
export type { EpochHeader, RequestContext, RequestHeaderReason, SessionHeader, SessionSeedEventState } from './headers.ts'

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

/** 会话的仅追加事件映射，支持通过声明合并扩展。消息历史从日志派生；事件使用无损 JSON 保存，序号连续。助手尝试事件内嵌原始响应流，以保存每次尝试的最终状态。 */
export interface SessionEventMap {

  /** 在获取排队输入或执行步骤前钩子之前开启轮次。拒绝、空输入、取消或失败可能使轮次直接结束而不进入步骤；进入步骤的消息由后续 user/message 事件记录。 */
  'turn/start': { turn: number }

  /** 结束轮次并记录原因。未进入步骤的轮次没有 step/start 或 step/end。轮次边界不等待持久化刷新；在空闲后读取持久化存储的调用方须自行完成刷新。 */
  'turn/end': {
    turn: number
    reason: TurnEndReason
  }

  /** 开启轮次中的一个步骤；每个步骤包含一次模型调用及其请求的工具执行。 */
  'step/start': {
    turn: number
    step: number
  }

  /** 结束指定轮次中的指定步骤。 */
  'step/end': {
    turn: number
    step: number
  }

  /** 模型可见的用户角色消息，包括用户输入、注入上下文和目标继续轮次的输入。content 原样进入消息视图，source 区分来源。 */
  'user/message': UserMessage

  /** 模型可见的系统提示词。首条系统消息位于消息视图节点 0；支持历史内系统提示词更新的路由可在同一系列追加变更，其他情况通过逐节点替换归并到头节点。空内容节点不生成消息；清空提示词时须清除所有活跃系统节点，避免旧指令继续生效。 */
  'system/message': {
    turn: number
    step: number
    message: SystemMessage
  }

  /** 步骤最终生成的助手消息，用于派生历史；usage 仅在适配器报告用量时存在。取消时已输出的文本或推理前缀仍可保存，并以 interrupted 标记；尚未分发的工具调用不包含在内。取消轮次没有此事件表示未输出模型可见内容。 */
  'assistant/message': {
    turn: number
    step: number
    message: AssistantMessage

    /** 带时间信息的精确模型响应流，紧凑保存但不合并增量块边界。 */
    stream: AssistantStreamRecord[]

    usage?: TokenUsage

    interrupted?: true
  }

  /** 未提交模型可见消息的模型尝试。内嵌响应流保存失败、重试、取消或流错误后的最终状态，无需生成历史消息。 */
  'assistant/attempt': {
    turn: number
    step: number
    stream: AssistantStreamRecord[]
  }

  /** 模型请求的工具调用。name 为工具名称，arguments 保留未经解析的原始 JSON 字符串，callId 关联对应的 tool/result。 */
  'tool/call': {
    turn: number
    step: number
    callId: ToolCallId
    name: string
    arguments: string
  }

  /** 已完成工具调用的结果，包含模型可见消息及可选的失败信息和展示元数据。reason 不进入模型内容；meta 由工具定义和解释，必须可无损序列化为 JSON，以便重放展示结果。 */
  'tool/result': {
    turn: number
    step: number
    message: ToolResultMessage

    /** 模型内容之外的失败标识与用户可见原因，仅在结果块 isError 为 true 时存在。 */
    error?: {
      name: string
      code: string
      reason?: string
    }

    meta?: JsonValue
  }

  /** 下一次请求的完整请求头，在请求发送前于当前步骤内记录。此事件只进入日志，最新快照用于重建请求配置。 */
  'request/header': {
    header: EpochHeader
    reason: RequestHeaderReason

    /** 请求头改变时，同时标记新的模型消息系列开始。 */
    startsSeries?: true
  }

  /** 下一次请求的路由元数据，仅在路由、容量或系统提示词更新模式改变时记录，不参与请求重建或请求头比较。输入容量判断使用当前绑定调用的能力，不使用旧快照。 */
  'request/context': RequestContext

  /** 标记本次会话初始化导入历史的结束位置，是 Session.firstLiveSeq 的持久化表示。新分叉在继承前缀后记录 inherited: true；最后一个带此标记的事件表示当前会话的继承边界，普通标记表示恢复或重放边界。仅 Session 构造函数应写入此事件，插件自行追加会使实时历史被误判为导入历史。跨边界未闭合的操作属于已结束的生命周期；此标记不能证明其他并发写入者是否存活。 */
  'session/end-seed': {
    inherited?: true
  }
}

/** 可追加的事件类型键，包括插件通过声明合并扩展的类型。 */
export type SessionEventType = keyof SessionEventMap

/** 不可变会话事件，以 type 区分 data 类型，支持 TypeScript 自动收窄。消息视图事件携带 surfaceOp，并按事件类型约束 sourceEventSeqs；非消息视图事件不携带消息视图元数据。 */
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    seq: SessionSeq  // 会话内部单调递增的序列号
    time: number  // Unix 时间戳，单位为毫秒
    data: SessionEventMap[K]

    /** 未知事件能否安全忽略。仅纯信息性且不影响重建的事件可设为 true；缺省时，读取器必须拒绝包含未知必需事件的日志。 */
    ignorable?: true
  } & (
    K extends SurfaceEventType
      ? SurfaceIntent<K>
      : {
        surfaceOp?: never
        sourceEventSeqs: never
      }
  )
}[T]
