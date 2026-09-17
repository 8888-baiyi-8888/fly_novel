import { Service, type Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, LlmResolvedModelInfo, LlmProviderInfo, LlmModelContext, FileAttachmentRef, ModelModality } from './types'
import { LlmAdapter } from './adapter'
import { LlmError } from './error'
import { normalizeLlmFailure } from './adapter-failure'
import { contentHasFile, projectFilesToText, contentHasImage, projectImagesForTextModel } from './content'
import { callConfigEquals, type LlmCallConfig } from './call-config'
import { deepFreeze } from './deep-freeze'
import { freezeMessage, type Message } from './message'

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmRuntime
  }
  interface Events {
    /** 调用 next 继续模型请求；不调用时由中间件返回替代流，异常直接传播。 */
    'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
  }
}

/** 管理模型路由及流式分发；注册方负责调用返回的清理函数注销路由。 */
export class LlmRuntime extends Service {
  private adapters = new Map<string, AdapterRegistration>()

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /**
   * 注册适配器拥有的路由；空路由或重复注册会在修改注册表前失败。
   * @param providers 适配器负责的路由标识。
   * @param adapter 提供模型解析与流式调用的适配器。
   * @returns 可重复调用的注销函数；不会删除后续注册的其他实例。
   */
  registerAdapter(providers: readonly string[], adapter: LlmAdapter): () => void {
    const pending = new Map<string, AdapterRegistration>()
    for (const provider of providers) {
      if (!provider.trim() || this.adapters.has(provider) || pending.has(provider)) {
        throw new LlmError('模型路由为空或已注册', 'INVALID_PROVIDER')
      }
      const info = adapter.providerInfo(provider)
      if (info.id !== provider || typeof info.name !== 'string' || !info.name.trim()) {
        throw new LlmError('适配器返回了无效的供应商信息', 'INVALID_PROVIDER')
      }
      pending.set(provider, { adapter, provider: Object.freeze({ id: provider, name: info.name }) })
    }
    for (const [provider, registration] of pending) this.adapters.set(provider, registration)
    return () => {
      for (const [provider, registration] of pending) {
        if (this.adapters.get(provider) === registration) this.adapters.delete(provider)
      }
    }
  }

  private detachedModalities(modalities: readonly ModelModality[] | undefined): readonly ModelModality[] | undefined {
    if (modalities === undefined) return undefined
    if (!Array.isArray(modalities) || modalities.some(value => typeof value !== 'string' || !value.trim())) {
      throw new LlmError('适配器返回了无效的输入模态', 'INVALID_MODEL_INFO')
    }
    return [...new Set(modalities)]
  }

  private registration(provider: string): AdapterRegistration {
    const registration = this.adapters.get(provider)
    if (!registration) throw new LlmError(`no adapter registered for provider "${provider}"`, 'NO_ADAPTER')
    return registration
  }
  /** 校验 Adapter 返回的精确模型信息，并创建一份与原对象分离的模型信息。 */
  private normalizeModelInfo(
    registration: AdapterRegistration,
    model: string,
    resolved: LlmResolvedModelInfo,
    ): LlmResolvedModelInfo {
    const provider = registration.provider.id

    // 1. 校验模型的基础元数据
    if (
        typeof resolved.provider !== 'string'
        || resolved.provider !== provider
        || typeof resolved.id !== 'string'
        || resolved.id !== model
        || typeof resolved.name !== 'string'
        || resolved.name.length === 0
        || (resolved.description !== undefined && typeof resolved.description !== 'string')
    ) {
        throw new LlmError(
        `adapter returned invalid exact model metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_INFO',
        )
    }

    // 2. 校验模型上下文窗口信息
    const context = resolved.context
    if (context !== undefined && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) {
        throw new LlmError(
        `adapter returned invalid context metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_CONTEXT',
        )
    }

    // 保留能力元数据：显式缺少某种模态表示“不支持该能力”，
    // 下游的预检查会据此判断是否允许对应输入（例如图片）。
    const inputModalities = this.detachedModalities(resolved.inputModalities)

    // 扩宽类型：Adapter 会从模型目录配置中获得该模式，因此这里按字符串进行检查。
    const systemPromptUpdate: string | undefined = resolved.systemPromptUpdate

    // 3. 校验系统提示词更新模式
    if (systemPromptUpdate !== undefined && systemPromptUpdate !== 'in-history') {
        throw new LlmError(
        `adapter returned invalid system prompt update mode for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_INFO',
        )
    }

    // 4. 校验模型默认最大输出 Token 数
    const defaultMaxTokens = resolved.defaultMaxTokens
    if (
        defaultMaxTokens !== undefined
        && (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens <= 0)
    ) {
        throw new LlmError(
        `adapter returned invalid default maxTokens for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_MAX_TOKENS',
        )
    }

    // 5. 根据已校验的数据重新构造模型信息，避免直接返回 Adapter 提供的原始对象
    const info: LlmResolvedModelInfo = {
        provider,
        id: model,
        name: resolved.name,
        ...resolved.description === undefined ? {} : { description: resolved.description },
        ...inputModalities === undefined ? {} : { inputModalities },
        ...context === undefined ? {} : { context: { contextWindow: context.contextWindow } },
        ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
        ...resolved.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: resolved.systemPromptUpdate },
    }

    // 6. 如果模型没有推理配置，到这里即可完成标准化
    const reasoning = resolved.reasoning
    if (reasoning === undefined) return info

    // 7. 校验推理强度（Reasoning Effort）配置
    if (reasoning.efforts.length === 0) {
        throw new LlmError(
        `adapter returned invalid reasoning metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_REASONING',
        )
    }

    const seen = new Set<string>()

    const efforts = reasoning.efforts.map((effort) => {
        if (
        typeof effort.id !== 'string'
        || effort.id.length === 0
        || typeof effort.name !== 'string'
        || effort.name.length === 0
        || (effort.description !== undefined && typeof effort.description !== 'string')
        || seen.has(effort.id)
        ) {
        throw new LlmError(
            `adapter returned invalid or duplicate reasoning effort metadata for provider "${provider}" model "${model}"`,
            'INVALID_MODEL_REASONING',
        )
        }

        seen.add(effort.id)

        return {
        id: effort.id,
        name: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
        }
    })

    // 8. 校验默认推理强度是否确实存在于 efforts 中
    if (reasoning.defaultEffort !== undefined && !seen.has(reasoning.defaultEffort)) {
        throw new LlmError(
        `adapter returned an unknown default reasoning effort for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_REASONING',
        )
    }

    // 9. 合并标准化后的基础信息和推理配置
    return {
        ...info,
        reasoning: {
        efforts,
        ...reasoning.defaultEffort === undefined
            ? {}
            : { defaultEffort: reasoning.defaultEffort },
        },
    }
    }

  /** 根据已经绑定的精确模型信息，校验并解析本次请求的控制参数。 */
  private resolveCallWithInfo(
    config: LlmCallConfig,
    info: LlmResolvedModelInfo,
    ): { config: LlmCallConfig; context?: LlmModelContext; modelInfo: LlmResolvedModelInfo } {

    // 1. 如果请求没有指定 maxTokens，则使用模型提供的默认 maxTokens
    const defaulted = config.maxTokens === undefined && info.defaultMaxTokens !== undefined
        ? { ...config, maxTokens: info.defaultMaxTokens }
        : config

    const reasoning = info.reasoning
    const requested = defaulted.reasoningEffort
    let resolvedConfig = defaulted

    // 2. 校验并解析 Reasoning Effort（推理强度）
    if (reasoning === undefined) {
        if (requested !== undefined) {
        throw new LlmError(
            `provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`,
            'UNSUPPORTED_REASONING_EFFORT',
        )
        }
    } else {
        const effective = requested ?? reasoning.defaultEffort

        if (effective !== undefined) {
        if (!reasoning.efforts.some(effort => effort.id === effective)) {
            throw new LlmError(
            `provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`,
            'UNSUPPORTED_REASONING_EFFORT',
            )
        }

        // 如果用户没有显式指定，则将模型的默认推理强度写入最终配置
        if (requested !== effective) {
            resolvedConfig = { ...defaulted, reasoningEffort: effective }
        }
        }
    }

    // 3. 返回最终请求配置、上下文信息以及模型信息
    return {
        config: resolvedConfig,
        ...info.context === undefined ? {} : { context: info.context },
        modelInfo: info,
    }
    }

  /** 通过附件和文件系统服务解析文件在当前执行环境中的可读路径。 */
  private fileReadPath(ref: FileAttachmentRef): string | undefined {
    let hostPath: string | undefined
    try {
      const attachments: { fileHostPath(ref: FileAttachmentRef): string | undefined } | undefined = this.ctx.get('attachments')
      hostPath = attachments?.fileHostPath(ref)
    } catch (error) {
      if (!(error instanceof LlmError) || error.code !== 'ATTACHMENT_NOT_FOUND') throw error
      // 附件不存在时使用无路径说明。
      // 其他服务错误继续传播，避免掩盖实现缺陷。
      return undefined
    }
    if (hostPath === undefined) return undefined
    // 仅声明所需的路径映射接口，避免依赖具体文件系统实现。
    // 映射服务未接入时返回不可访问。
    const fs: { processPathFromHostPath(hostPath: string): string | undefined } | undefined = this.ctx.get('fs')
    return fs?.processPathFromHostPath(hostPath)
  }
  /** 移除其他适配器拥有的历史路由所携带的私有重放状态。 */
  private forAdapter(options: GenerateOptions, adapter: LlmAdapter): GenerateOptions {
    const messages: Message[] = options.messages.map((message) => {
      const source = message.source
      if (message.role !== 'assistant' || source.kind !== 'model' || source.replayState === undefined) return message
      if (this.adapters.get(source.provider)?.adapter === adapter) return message
      return freezeMessage({
        ...message,
        source: { kind: 'model', provider: source.provider, model: source.model },
      })
    })
    if (messages.every((message, index) => message === options.messages[index])) return options
    const filtered = { ...options, messages }
    return Object.isFrozen(options) ? deepFreeze(filtered) : filtered
  }

  /**
   * 最终的 Adapter 边界。
   *
   * Adapter 的选择、分发（dispatch）、迭代器创建以及迭代过程中的失败，都会被转换为一个最终的失败 Chunk。
   *
   * Middleware（中间件）以及下游 Consumer（消费者）的失败，仍然会作为插件错误或消费者错误直接推出。
   */
  private async * adapterStream(
    options: GenerateOptions,
    prepared?: PreparedDispatch,
  ): AsyncGenerator<StreamChunk> {
    let iterator: AsyncIterator<StreamChunk>
    try {
        options.signal?.throwIfAborted()
        // 找到对应的 Adapter
        const registration = prepared?.registration ?? this.registration(options.provider)
        const adapter = registration.adapter
        let modelInfo: LlmResolvedModelInfo
        let resolvedConfig: LlmCallConfig
        let dispatch: (options: GenerateOptions) => AsyncIterable<StreamChunk>

        // 准备模型调用
        if (prepared === undefined) {
        const adapterCall = await adapter.prepareCall(options.provider, options.model, options.signal)
        modelInfo = this.normalizeModelInfo(registration, options.model, adapterCall.model)

        // 确定使用的请求配置
        resolvedConfig = this.resolveCallWithInfo(options, modelInfo).config
        dispatch = options => adapterCall.stream(options)
        } else {
        modelInfo = prepared.modelInfo
        resolvedConfig = prepared.config
        dispatch = prepared.dispatch
        }

        if (prepared !== undefined && !callConfigEquals(options, resolvedConfig)) {
        throw new LlmError(
            'prepared LLM call config changed before adapter dispatch',
            'INVALID_PREPARED_CALL',
        )
        }

        const resolvedOptions = callConfigEquals(options, resolvedConfig)
        ? options
        : Object.isFrozen(options)
            ? deepFreeze({ ...options, ...resolvedConfig })
            : { ...options, ...resolvedConfig }

        // 文件和图片的兼容处理
        let projectedMessages: readonly Message[] = resolvedOptions.messages

        if (projectedMessages.some(message => contentHasFile(message.content))) {
        projectedMessages = projectFilesToText(projectedMessages, ref => this.fileReadPath(ref))
        }

        if (
        modelInfo.inputModalities !== undefined
        && !modelInfo.inputModalities.includes('image')
        && projectedMessages.some(message => contentHasImage(message.content))
        ) {
        projectedMessages = projectImagesForTextModel(projectedMessages)
        }

        const projectedOptions = projectedMessages === resolvedOptions.messages
        ? resolvedOptions
        : Object.isFrozen(resolvedOptions)
            ? deepFreeze({ ...resolvedOptions, messages: projectedMessages as Message[] })
            : { ...resolvedOptions, messages: projectedMessages as Message[] }

        // 调用适配器
        options.signal?.throwIfAborted()
        const stream = dispatch(this.forAdapter(projectedOptions, adapter))
        iterator = stream[Symbol.asyncIterator]()
    } catch (error: unknown) {
        yield adapterFailureChunk(error, options.signal)
        return
    }

    let completed = false

    // 循环读取流式输出
    try {
        while (true) {
        let item: { done: true } | { done: false; value: StreamChunk }

        try {
            const next = await iterator.next()

            item = next.done
            ? { done: true }
            : { done: false, value: next.value }
        } catch (error: unknown) {
            // 错误转换和资源清理
            yield adapterFailureChunk(error, options.signal)
            return
        }

        if (item.done) {
            completed = true
            yield adapterFailureChunk(new LlmError('适配器未返回结束块就结束了响应', 'INVALID_RESPONSE'), options.signal)
            return
        }

        // 在 yield 之前结束 Adapter 所属的 try：
        // 当生成器恢复执行时传回来的 Consumer / Middleware 错误
        // 必须继续保持为直接抛出的错误。
        yield item.value
        if (item.value.type === 'finish') return
        }
    } finally {
        if (!completed) {
        const close = iterator.return?.bind(iterator)
        if (close) await close()
        }
    }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithRegistration(options)
  }

  private streamWithRegistration(
    options: GenerateOptions,
    prepared?: PreparedDispatch,
  ): AsyncIterable<StreamChunk> {
    return this.ctx.waterfall(
        this,
        'llm/stream',
        options,
        () => this.adapterStream(options,prepared)
    )
  }
}

/** 将适配器异常转换为流协议的终止结果。 */
function adapterFailureChunk(error: unknown, signal?: AbortSignal): StreamChunk {
  const failure = normalizeLlmFailure(error)
  return {
    type: 'finish',
    reason: signal?.aborted || failure.code === 'ABORTED'
      ? { kind: 'aborted', failure }
      : { kind: 'error', failure },
  }
}
interface AdapterRegistration {
    readonly adapter: LlmAdapter
    readonly provider: LlmProviderInfo
}

interface PreparedDispatch {
  readonly registration: AdapterRegistration
  readonly config: LlmCallConfig
  readonly modelInfo: LlmResolvedModelInfo
  readonly dispatch: (options: GenerateOptions) => AsyncIterable<StreamChunk>
}
