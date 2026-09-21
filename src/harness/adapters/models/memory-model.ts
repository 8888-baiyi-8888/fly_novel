import { ChatRequest, ChatResponse, ModelClient } from "../../model/contract";

export interface MemoryModelOptions {
  /** 按结构化 schema 名称返回预置 JSON 文本。 */
  responses?: Record<string, string>;
  /** 忽略其他配置，固定返回该文本（用于测试失败分支）。 */
  forceContent?: string;
  /** 完全自定义响应；优先级最高（用于测试重试等场景）。 */
  responder?: (request: ChatRequest) => string;
}

/**
 * 内存模型：不发起真实网络请求，按配置返回预置内容。
 * 用于本地演示与测试；生产环境请使用真实供应商适配器。
 */
export class MemoryModel implements ModelClient {
  private readonly responses: Record<string, string>;
  private readonly forceContent?: string;
  private readonly responder?: (request: ChatRequest) => string;

  constructor(options: MemoryModelOptions = {}) {
    this.responses = options.responses ?? {};
    this.forceContent = options.forceContent;
    this.responder = options.responder;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (this.responder !== undefined) {
      return { content: this.responder(request) };
    }
    if (this.forceContent !== undefined) {
      return { content: this.forceContent };
    }
    const name = request.structured?.name;
    const content = name !== undefined && this.responses[name] !== undefined ? this.responses[name] : "{}";
    return { content };
  }
}
