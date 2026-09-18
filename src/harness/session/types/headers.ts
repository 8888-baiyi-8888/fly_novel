import type { LlmCallConfig, LlmCallConfigAdapterDefaults, SystemPromptUpdate, ToolSchema } from '@fly-novel/llm'
import type { SessionId } from './identifiers.ts'

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

/** 请求头快照的记录原因：initial 表示首次记录，resume 表示恢复后首次请求，change 表示请求头改变，series 表示配置未变但开始新消息系列。配置改变且同时开始新系列时，由 startsSeries 保留系列边界。 */
export type RequestHeaderReason = 'initial' | 'resume' | 'change' | 'series'

/**
 * 当前会话逻辑格式版本，写入每个新建的 {@link SessionHeader}。
 * 会话与持久化代码只接纳此版本；仅读取头部的读取器识别受支持的历史格式，读取事件体时组合构建期确定的相邻迁移链，在构造 Session 前统一转换到当前版本。
 * 版本号为单调递增整数，不区分主次版本。是否升级由写入器的输出决定，而非新读取器能接纳什么：当旧运行时无法语义完整地处理新日志时必须升级。
 * 仅能解析而不报错并不代表正确；静默跳过影响重建的内容属于错误读取。
 * 达到升级条件的是结构变化：头部结构、{@link SessionEvent} 信封、核心事件语义或消息视图机制（{@link SurfaceEventType} 集合和 {@link SurfaceOp} 变体）。
 * 新增普通事件类型不提升格式版本，其兼容性由每个事件的 {@link SessionEvent.ignorable} 控制。
 * 无法确定时应提升版本：接近恒等转换的迁移成本很低，漏升版本却会让旧运行时静默误读新日志。
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

/** 恢复历史的共享状态：detached 表示独立持有；shared-frozen 允许深度冻结的共享值与独立持有的未冻结值共存。 */
export type SessionSeedEventState = 'detached' | 'shared-frozen'
