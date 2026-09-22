import { callConfiguredLlm } from "./call-llm";
import { LlmError } from "../llm/error";
import { ModelCallError } from "../harness/model/contract";
import type { ChatMessage, ChatRequest, ChatResponse, ModelClient } from "../harness/model/contract";
import type { Message } from "../llm/message";
import type { MessageId } from "../llm/brand";

/** 把 harness 契约消息（role + 纯文本）转换为 src/llm 的 Message。 */
export function toLlmMessages(messages: ChatMessage[]): Message[] {
  return messages.map((message, index) => ({
    // 品牌类型只在编译期存在；运行时就是普通字符串，id 只需在当前请求内稳定。
    id: `configured-${index}` as MessageId,
    role: message.role,
    // 适配器只读 role/content；source 仅用于展示与来源追踪，这里统一标记为用户来源。
    source: { kind: "user" },
    content: [{ type: "text", text: message.content }],
  }));
}

export interface ConfiguredLlmModelOptions {
  /** settings.json 顶层的供应商键，如 "qwen"。 */
  readonly provider: string;
  /** 覆盖供应商默认模型；省略时使用 settings[provider].model。 */
  readonly model?: string;
  /** 请求超时（毫秒），默认 180_000（3 分钟）。 */
  readonly timeoutMs?: number;
}

/**
 * 桥接：把 harness 的 ModelClient 契约翻译为项目正式 LLM 机制
 * （src/config 读取并解密凭据 + src/llm 适配器路由 + callConfiguredLlm 调用）。
 * harness/novel 不直接读取应用配置，因此本桥接位于 app 组装层。
 */
export class ConfiguredLlmModel implements ModelClient {
  private readonly provider: string;
  private readonly model?: string;
  private readonly timeoutMs: number;

  constructor(options: ConfiguredLlmModelOptions) {
    if (!options.provider.trim()) throw new Error("ConfiguredLlmModel 必须提供非空 provider");
    this.provider = options.provider.trim();
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const text = await callConfiguredLlm({
        provider: this.provider,
        ...(this.model === undefined ? {} : { model: this.model }),
        messages: toLlmMessages(request.messages),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        signal: controller.signal,
      });
      if (text === null) throw new ModelCallError("模型返回空内容");
      return { content: text };
    } catch (error) {
      if (error instanceof ModelCallError) throw error;
      if (controller.signal.aborted) {
        throw new ModelCallError(`模型请求超时（${this.timeoutMs}ms）`);
      }
      if (error instanceof LlmError) {
        throw new ModelCallError(`模型调用失败（${error.code}）：${error.message}`, { cause: error });
      }
      throw error instanceof Error
        ? new ModelCallError(`模型调用失败：${error.message}`, { cause: error })
        : error;
    } finally {
      clearTimeout(timer);
    }
  }
}
