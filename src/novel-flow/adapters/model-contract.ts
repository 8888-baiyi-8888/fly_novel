/**
 * harness/model：大模型调用契约。
 *
 * 本目录只定义 Harness 调用大语言模型的统一接口，
 * 供应商 SDK、网络与认证实现放在 harness/adapters/models/。
 */

/** 消息角色。 */
export type MessageRole = "system" | "user" | "assistant";

/** 一次对话中的一条消息。 */
export interface ChatMessage {
  role: MessageRole;
  content: string;
}

/** 结构化输出要求：模型必须返回符合给定 schema 的 JSON。 */
export interface StructuredOutputSpec {
  /** schema 名称，用于向模型描述返回结构（如 creative_draft）。 */
  name: string;
  /** 对模型可读的字段说明。 */
  description: string;
}

/** 一次模型调用请求。 */
export interface ChatRequest {
  messages: ChatMessage[];
  /** 要求结构化输出时设置；模型应返回 content 为符合描述的 JSON 文本。 */
  structured?: StructuredOutputSpec;
  temperature?: number;
  maxTokens?: number;
}

/** 一次模型调用的响应。 */
export interface ChatResponse {
  /** 模型返回的正文（结构化输出时是 JSON 文本）。 */
  content: string;
}

/** 模型调用失败（供应商错误、网络、认证等）。 */
export class ModelCallError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelCallError";
  }
}

/** 调用方（业务层）可注入的最小模型接口。 */
export interface ModelClient {
  chat(request: ChatRequest): Promise<ChatResponse>;
}
