import type { GenerateOptions, StreamChunk, LlmResolvedModelInfo, LlmProviderInfo, LlmImageRequestPricing, LlmModelInfo } from './types'
import type { ResolvedRetryPolicy } from './retry-policy'

/** 将适配器的一次模型解析结果与同一代实例的流式调用绑定。 */
export interface PreparedAdapterCall {
  /** 与 stream 使用同一代适配器的精确模型元数据。 */
  readonly model: LlmResolvedModelInfo
  /** 使用已绑定的实例分发请求，不重新读取动态连接信息。 */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * 将统一消息和流式协议转换为供应商请求的适配器。
 *
 * 使用 `ctx.llm.registerAdapter(providers, adapter)` 注册具体实现。
 *
 * 实现负责请求协议、认证和取消；运行时负责路由、模型默认值及失败转换。
 */
export abstract class LlmAdapter {
  /**
   * 描述当前 Adapter 所拥有的一条 Provider 路由。
   *
   * @param provider - 注册当前实例时传给 `registerAdapter()` 的一条路由。
   * @returns 独立的展示元数据，其中 id 必须与 `provider` 相同。
   */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /**
   * 返回与当前 Provider 路由绑定的、由 Provider 自身定义的重试策略。
   *
   * @param _provider - 注册当前实例时传给 `registerAdapter()` 的一条路由。
   * @returns 已解析的重试策略声明；undefined 表示未声明。运行时不执行重试。
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  /**
   * 为某个精确的模型路由解析 Provider 侧的请求图片计价信息。
   *
   * 默认实现不声明任何计价信息，因此消费者会退回使用自己的中性估算方式。
   *
   * 实现类必须同步返回结果，不能执行 I/O；
   * Token Meter（Token 计量器）会在每次测量时解析该信息。
   *
   * @param _provider - 注册当前实例时传给 `registerAdapter()` 的一条路由。
   * @param _model - 传给 {@link GenerateOptions.model} 的精确模型 ID。
   * @returns 当前路由自身定义的图片计价信息；
   *          如果该路由没有声明，则返回 `undefined`。
   */
  imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined {
    return undefined
  }

  /**
   * 列出当前 Adapter 针对某个自己拥有的 Provider，
   * 目前可以对外展示（advertise）的模型。
   *
   * 返回结果仅用于参考：
   * Adapter 仍然可以接受未出现在该列表中的模型 ID，
   * 消费者不能因为某个模型不在列表中，就拒绝对应请求。
   *
   * @param _provider - 当前 Adapter 所拥有的一条 Provider 路由。
   * @returns 按照 Adapter 偏好顺序排列的、可发现的模型列表。
   */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  /**
   * 解析某个精确模型当前能够获得的全部元数据。
   *
   * 该查询独立于用于展示/发现的模型目录，
   * 并且不会验证请求路由是否合法。
   *
   * @param provider - 当前 Adapter 所拥有的一条 Provider 路由。
   * @param model - 传给 {@link GenerateOptions.model} 的精确模型 ID。
   * @param _signal - 用于取消此次精确模型查询；
   *                  异步实现必须在取消发生后尽快结束。
   *
   * @returns Provider / Model 身份信息，以及所有可获得的
   *          上下文、调用默认值和推理相关元数据。
   */
  resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /**
   * 将精确模型的元数据，以及最终的请求分发，
   * 绑定到同一个 Adapter Generation（适配器代次/版本实例）上。
   *
   * 动态 Adapter 会重写该方法。
   *
   * 这样可以防止：
   * 在“请求准备”和“真正分发请求”之间配置发生变化时，
   * 把某一代 Adapter 的模型能力信息，
   * 与另一代 Adapter 的 Endpoint（请求端点）错误地组合起来。
   *
   * @param provider - 已注册的 Provider 路由。
   * @param model - 精确的模型 ID。
   * @param signal - 用于取消模型解析操作。
   *
   * @returns 模型元数据，以及一个绑定到当前这一代 Adapter 的流式调用入口。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  /**
   * 以原始 Chunk（数据块）的形式，对一次模型调用进行流式输出。
   *
   * 这是 LlmAdapter 唯一必须实现的方法。
   *
   * @param options - 已经完成完整组装的请求；
   *                  实现类必须正确处理 `options.signal`。
   *
   * @returns Chunk 数据流，并遵守 `StreamChunk` 中定义的 Adapter 契约。
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
