import type {ReasoningEffortId, AttachmentId, ToolCallId, ProviderRequestId} from "./brand"
import type { Branded } from '@fly-novel/util'
import type {Message} from "./message"

/** 一个已注册 Provider 路由的展示元数据。 */
export interface LlmProviderInfo {
  /** Provider 路由的唯一标识，用于 {@link GenerateOptions.provider}。 */
  id: string

  /** 供选择器和诊断信息使用的、便于人类阅读的 Provider 名称。 */
  name: string
}

/**
 * 适配器插件可通过配置启用的一条供应商路由，
 * 无论该路由当前是否已经注册。
 * 此类型仅描述可配置路由；当前运行时尚未实现配置目录查询。
 */
export interface LlmConfigurableProvider {
  /** 配置后要启用的供应商路由标识。 */
  provider: string

  /** 配置界面中显示的供应商名称。 */
  displayName: string

  /** 用于配置此供应商的用户设置命名空间。 */
  settingsNs: string

  /**
   * 从该命名空间的设置根节点，到此供应商配置对象的路径。
   * 如果整个设置区域就是该供应商的配置对象，则为空数组。
   */
  settingsPath: readonly string[]

  /**
   * 此路由是否仅因配置中的声明才被所属适配器识别，
   * 例如适配器未内置相关信息的网关或自托管服务器。
   *
   * 未提供此字段，表示适配器不作这种区分；
   * false 表示适配器作此区分，且该路由是其内置路由。
   *
   * 只有适配器能够判断这一点：从外部看，
   * 用户新增的路由和用户修改过配置的内置路由，
   * 都表现为一份已保存的供应商配置。
   */
  declared?: boolean

  /** 用于修复配置问题的诊断信息；未受影响的模型可能仍可正常使用。 */
  error?: string
}

export interface LlmModelDiscoveryRequest {
  /**
   * 当配置草稿编辑的是已有路由时，指定该路由。
   * 如果适配器已经掌握该路由的模型信息，就直接使用这些信息，
   * 而不向端点查询——适配器自身的注册信息更可靠，
   * 而且不需要发起网络请求。
   */
  provider?: string

  /**
   * 要查询的 API 端点地址。
   * 如果适配器已经掌握该路由的信息，可以省略；
   * 否则必须提供。
   */
  baseURL?: string

  /** 配置草稿中指定的端点通信协议（如果有）。 */
  api?: string

  /** 仅用于本次查询的凭据，不能持久化。 */
  apiKey?: string
}

/**
 * 端点返回的一个模型的信息。
 * 除 id 外，所有字段均为可选，因为大多数供应商的模型列表只提供 id。
 * 配置界面采用这些模型时，仍需补齐适配器所需的容量参数。
 */
export interface LlmDiscoveredModel {
  /** 端点接受的模型 ID。 */
  id: string

  /** 端点提供的可读模型名称（如果有）。 */
  name?: string

  /** 请求与响应合计的最大上下文容量（如果端点提供）。 */
  contextWindow?: number

  /** 最大输出 token 数量（如果端点提供）。 */
  maxTokens?: number
}

/** 支持声明的光栅图像格式。 */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** 不可变标准化图像的可序列化引用。 */
export interface ImageAttachmentRef {
  /** 不透明存储标识，不是文件路径或携带凭据的 URL。 */
  attachmentId: AttachmentId
  /** 根据存储字节验证的媒体类型。 */
  mediaType: ImageMediaType
  /** 编码后的准确字节数。 */
  bytes: number
  /** 编码图像的像素宽度。 */
  width: number
  /** 编码图像的像素高度。 */
  height: number
  /** 去掉本地路径信息后的可选显示名称。 */
  name?: string
  /** 应用 EXIF 方向后、缩放前的输入尺寸；仅在缩小图像时提供。 */
  originalDimensions?: {
    width: number
    height: number
  }
}
/** 原始文件的可序列化引用；字节不做归一化，attachmentId 是原始字节的 sha256 摘要。 */
export interface FileAttachmentRef {
  /** 内容寻址的存储标识，不是文件路径或携带凭据的 URL。 */
  attachmentId: AttachmentId
  /** 清理后的显示文件名，同时作为存储对象的末级名称。 */
  name: string
  /** 文件的准确字节数。 */
  bytes: number
}
/** 对最终用户可见的纯文本。 */
export interface TextBlock {
  type: 'text'
  text: string
}

/** 推理 / 思考内容，与用户可见文本相区分。 */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/**
 * 持久化的光栅图像引用，可用于用户或助手的内容中。
 * 该块在设计上与角色无关；助手侧的渲染是为了向前兼容——
 * 当前生产环境中的适配器声明仅支持文本输出，
 * 因此目前只有用户消息可以携带图像。
 */
export interface ImageBlock {
  type: 'image'

  /** 由附件服务管理的不可变字节数据以及图像固有的显示元数据。 */
  attachment: ImageAttachmentRef

  /**
   * 该字段来源于持久化的图像卸载（offload）决策，
   * 或在消息重写过程中被保留下来。
   *
   * 每条路由都会发送用于标识该图像及其可用只读路径的占位文本，
   * 而不是直接发送图像字节数据。
   */
  offloaded?: true
}

/**
 * 持久化的原始文件引用，可用于用户内容中。
 *
 * 文件永远不会以原生形式发送给模型提供商（Provider）：
 * 在请求组装阶段，每个文件引用都会被转换为确定性的句柄文本，
 * 其中包含文件名、字节大小以及保存后的只读路径。
 *
 * 因此，适配器（Adapter）和模型提供商（Provider）看到的是
 * 用于替代文件的文本，而持久化日志中仍会保留结构化的文件引用，
 * 用于展示和权限控制。
 */
export interface FileBlock {
  type: 'file'

  /** 由附件服务管理的不可变原始字节数据以及用于展示的元数据。 */
  attachment: FileAttachmentRef
}

/** 模型请求执行的一次工具调用。 */
export interface ToolCallBlock {
  type: 'tool-call'

  /** 由模型提供商生成的调用 ID，用于与对应的工具结果进行关联。 */
  id: ToolCallId

  name: string

  /** 模型生成的原始 JSON 字符串。 */
  arguments: string
}

/** 一次工具调用的执行结果，会被发送回模型。 */
export interface ToolResultBlock {
  type: 'tool-result'

  toolCallId: ToolCallId

  content: ContentBlock[]

  isError?: boolean
}

/**
 * 以 `type` 为键、支持通过声明合并（Declaration Merging）进行扩展的内容块映射。
 *
 * 新增核心内容块时，必须同时提供适配器（Adapter）、
 * UI 和上下文压缩（Compaction）方面的支持。
 */
export interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'image': ImageBlock
  'file': FileBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}

/**
 * 内容块 `type` 标签的类型集合；
 * 随着插件向 {@link ContentBlockMap} 添加新的条目，该类型会自动扩展。
 */
export type ContentBlockType = keyof ContentBlockMap

/**
 * 任意已知的内容块类型，由 {@link ContentBlockMap} 推导得到；
 * 可以根据 `type` 进行分支处理，并为未知类型保留兜底处理，
 * 因为该映射支持通过声明合并进行扩展。
 */
export type ContentBlock = ContentBlockMap[ContentBlockType]

/** 发送给模型的工具 JSON Schema，属于 GenerateOptions 请求协议。 */
export interface ToolSchema {
  name: string
  description: string
  /** 工具参数的 JSON Schema 对象。 */
  parameters: Record<string, unknown>
}

/** 一次完整组装后的模型请求 */
export interface GenerateOptions {
    provider: string  // 已注册的 Provider 路由，用于选择对应的Adapter 实例
    model: string  //模型名称
    reasoningEffort?: ReasoningEffortId  //由 Adapter 管理的推理强度（Reasoning Effort），针对当前这个具体模型进行选择

    /**
     * 按顺序排列的对话消息，也就是 Provider 最终实际看到的消息。
     *
     * 如果请求由 Agent Loop 构建，则这里传入的是经过处理后的历史消息
     * 其中最前面的 system 角色消息携带系统提示词。
     *
     * 如果是手动构建的一次性请求（one-shot），则可以直接传入任意消息列表。
     */
    messages: Message[]
    /**
     * 提供给一次性调用者（one-shot caller）的系统提示词文本。
     *
     * Adapter 会把它映射到对应 Provider 的 system 位置，
     * 并放在 `messages` 之前。
     *
     * 如果请求由 Agent Loop 构建，则该字段保持 undefined，
     * 因为系统提示词已经包含在 messages 的 system 消息中。
     */
    system?: string
    tools?: ToolSchema[] //工具定义（Tool Schema）， Adapter 会将其映射到 Provider 的 ‘tools’ 字段。
    temperature?: number //采样温度
    maxTokens?: number //最大生成 token 数量
    /**
     * 停止序列（Stop Sequence）。
     * 当模型生成这些字符串中的任意一个时，会立即停止生成。
     * Adapter 会将其映射到对应 Provider 的 stop 字段。
     * 例如 OpenAI 的 `stop`
     * 触发停止的字符串本身不会包含在最终输出中。
     */
    stop?: string[]
    signal?: AbortSignal //用于取消请求的信号
    /**
     * 由 Agent Loop 写入的 Session（会话）身份标识，用于请求路由。
     * Replay（重放）机制使用它来区分不同的游标（cursor）；
     * Adapter 也可以将其映射为模型不可见的传输层元数据
     */
    sessionId?: Branded<'SessionId'>

    /**
     * 对辅助模型调用进行与 Provider 无关的用途分类。
     * Adapter 可以根据 purpose：
     * 1. 将其映射为模型不可见的传输层元数据；
     * 2. 使用针对特定用途的生成策略。
     * 普通的对话请求不会设置该字段。
     * compaction（压缩）用途的请求会在生成前对上下文进行压缩；
     * session-title（会话标题）生成 Session 标题。
     */
    purpose?: 'compaction' | 'session-title'
}

/** 单次调用的 Token 统计；inputTokens 仅计未缓存输入，缓存读取和写入分别统计。适配器应从包含缓存命中的输入总数中扣除命中部分。 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** 包含全部输入和输出的准确总量；无法获得可靠计数或计数不一致时省略。 */
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/**
 * 可序列化的 Provider（模型提供商）或传输层失败信息；至于这些失败原因是否可以重试，由上层策略决定。
 */
export interface LlmFailure {
    readonly message: string  // 供人阅读的 Provider 或传输失败信息
    readonly code: string  // 稳定的、与具体 Provider 无关的机器路由错误码
    readonly status?: number  // Provider 返回的 HTTP 状态码（如果可以获取）
    readonly providerRetryAfterMs?: number  // Provider 要求的重试等待时间，单位为毫秒。仅在该值有效且可以获取时间提供
    readonly requestId?: ProviderRequestId //Provider 生成的不透明请求标识符，用于诊断和排查问题

    /**
     * 当 code 为 `IMAGE_OFFLOAD_REQUIRED`时：
     * 表示为了让同一个请求满足当前路由精确的字节大小限制，
     * 还需要将多少个“最早保留的图片出现项”进行卸载（offload）。
     *
     * 具体卸载和重试由调用方负责，本模块只携带所需数量。
     */
    readonly offloadImages?: number
}

/**
 * 模型响应停止的原因
 * 支持通过声明合并（Declaration Merging）进行扩展，因此 Adapter 可以暴露特定 Provider 自有的停止原因
 */
export interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted'; failure: LlmFailure }
  'error': { kind: 'error'; failure: LlmFailure }
}
/** 从可扩展 FinishReasonMap 推导的结束原因；处理 kind 时为扩展保留默认分支。 */
export type FinishReason = FinishReasonMap[keyof FinishReasonMap]
/**
 * Adapter 私有的、可进行无损 JSON 序列化的状态信息，用于对一次成功响应进行 Replay（重放）。
 *
 * 这些状态通过最终的 `finish` StreamChunk 携带，
 * 并最终存储在组装完成的Assistant Message（助手消息）的 model source（模型来源信息）中。
 *
 * `response` 和 `blocks` 两部分数据对于调用方来说都是不透明的，调用方不应解析或理解它们的具体内容。
 *
 * 调用方与 Adapter 之间共享的只有这种“两部分”的结果约定。 因此，在不读取这两部分具体内容的情况下，
 * Assembly（消息组装过程）仍然可以保证：
 * 已存储的metadata（元数据） 与 已存储的 content（内容） 保持正确的对应关系。
 */
export interface ReplayEnvelope{
    /**
     * 响应级别（Response-level）的 Adapter 私有元数据。例如：
     * -Provider 返回的响应ID
     * -Provider 原生的停止原因（native stop reason）
     */
    response: unknown

    /**
     * Block 级别（Per-block）的Adapter私有元数据。
     *
     * 每一个发出的Block都对应这里的一个元素，顺序按照这些 Block 在流中第一次出现的顺序排列。
     *
     * 当 Assembly（组装过程）丢弃某个 Block 时，也会同时丢弃 `blocks`中相同位置的元数据。
     *
     * 如果这里的 entries（条目）数量与实际发出的 Block数量不一致，那么整个 ReplayEnvelope 都会被丢弃。
     *
     * 如果某个Adapter 的 Replay 元数据 与 Block 结构无关， 那么 Adapter 可以不提供这个字段。
     *
     * 此时 ReplayEnvelope 会原样通过 Assembly，不需要进行 Block 对齐。
     */
    blocks?: readonly unknown[]
}

/**
 * Adapter 发出的原始流式协议。
 * Block（内容块）的 index 用于关联交错到达的增量数据（delta），`block-end`会携带已经完整组装好的 Block。
 *
 * Adapter 会在最终的finish事件之前发送 usage（Token使用情况），并且在 finish 之后不会再发送任何内容。
 *
 * 工具调用的参数会保持为原始 JSON 字符串。
 *
 * Adapter 的具体实现可能会抛出异常，但是 `LlmRuntime.stream()` 会对这些失败进行统一处理：
 * 再将流暴露给消费者之前，把失败转换成最终的`error`或`aborted`类型的finish事件。
 */
export type StreamChunk =
    | {type: 'block-start', index: number, block: ContentBlockType}
    | {type: 'text-delta', index: number, text: string}
    | {type: 'reasoning-delta', index: number, text: string}
    | {type: 'tool-call-delta', index: number, id: ToolCallId, name?: string, argumentsDelta: string}
    | {type: 'block-end', index: number, block: ContentBlock}
    | {type: 'usage', usage: TokenUsage}
    | {
        type: 'finish',
        reason: FinishReason,
        replayState?: ReplayEnvelope  // 成功响应对应的 Replay（重放）元数据；参见 {@link ReplayEnvelope}。
    }

/** 支持通过声明合并进行扩展的 Provider 模型模态词汇表。 */
export interface ModelModalityMap {
  text: 'text'
  image: 'image'
}

/** 任意已声明的 Provider 模型模态。 */
export type ModelModality = ModelModalityMap[keyof ModelModalityMap]

/** 由某个 Adapter 发现的一个模型，是否属于模型目录提供参考，不用于请求校验 */
export interface LlmModelInfo{
    provider: string  // 拥有该模型条目的 Provider 路由。
    id: string  // 传递给 {@link GenerateOptions.model} 的模型 ID。
    name: string  // 供选择器使用的人类可读模型名称。
    description?: string  // 可选的面向用户的描述，用于区分其他相似模型。
    inputModalities?: readonly ModelModality[]  //接受的请求模态；字段不存在表示未知，而明确未包含某种模态则表示不支持该能力。
}

/** 由 Provider 管理的、针对某个精确 Provider/Model 路由的上下文容量。 */
export interface LlmModelContext {
  /** 请求与响应合计所允许的最大上下文 Token 数。 */
  contextWindow: number
}

export interface LlmModelReasoningInfo {
  /** 按照 Adapter 首选的展示顺序排列的受支持推理强度。 */
  efforts: readonly LlmReasoningEffortInfo[]

  /**
   * 由 Adapter 配置的默认推理强度。
   * 当调用方未指定推理强度时，该默认值会被填充到请求中。
   * 如果不存在该字段，则保留 Provider 自身的默认设置。
   */
  defaultEffort?: ReasoningEffortId
}

/** 由 Adapter 管理的某个推理强度的展示元数据。 */
export interface LlmReasoningEffortInfo {
  /** {@link GenerateOptions.reasoningEffort} 接受的不透明稳定值。 */
  id: ReasoningEffortId

  /** 供选择器和诊断使用的人类可读推理强度名称。 */
  name: string

  /** 可选的面向用户的描述，用于区分其他相似的推理强度。 */
  description?: string
}

/**
 * 模型如何应用在对话过程中发生变化的系统提示词。
 *
 * `'in-history'`：模型会读取 `messages` 中任意位置最新的 `system` 消息，
 * 并将其作为当前完整且实际生效的系统提示词。
 *
 * 因此，发生变化后的系统提示词可以放在已缓存的历史消息之后，
 * 而无需重写第 0 条消息。
 */
export type SystemPromptUpdate = 'in-history'

/**
 * 由负责该精确 Provider 路由的 Adapter 解析得到的模型元数据
 */
export interface LlmResolvedModelInfo extends LlmModelInfo {
    context?: LlmModelContext  // Provider 所定义的上下文容量信息（如果已知道）

    /**
     * 由 Adapter 配置的 “单次请求最大输出 Token 数”的默认值。
     * 当调用方没有显式指定最大输出 Token 数时，会使用这个默认值进行补全。
     */
    defaultMaxTokens?: number

    /**
     * 由 Adapter 管理的、可供选择的推理等级信息（如果该模型对外提供这些等级）。
     */
    reasoning?: LlmModelReasoningInfo

    /**
     * 声明在会话进行过程中， System Prompt（系统提示词）发生变化时应该如何处理。
     * 如果没有该字段，则意味着只读取会话最开始的那条System Message（系统消息）。
     */
    systemPromptUpdate?:SystemPromptUpdate
}

/** 一次图片出现项在精确模型路由下的请求成本，包含视觉 Token 和附带或替代图片的文本；文本 Token 由调用方估算。 */
export interface LlmImageRequestPrice {
  /** 保留图片的视觉 Token 数；仅发送替代文本时为 0。 */
  visualTokens: number
  /** 此图片出现项实际发送给模型的文本，由调用方估算 Token。 */
  text: string
}

/** 精确模型路由的图片成本计算接口；必须同步返回，不执行 I/O。 */
export interface LlmImageRequestPricing {
  /**
   * 逐项计算请求图片的成本。
   * @param images 按请求顺序排列的图片出现项；offloaded 项仅按占位文本计算。
   * @returns 与输入下标一一对应的成本列表。
   */
  priceImages(images: readonly ImageBlock[]): readonly LlmImageRequestPrice[]
}
