import { ChatRequest, ChatResponse, ModelClient, ModelCallError } from "../../model/contract";

/**
 * OpenAI 兼容模型适配器配置。
 * 适用于所有 OpenAI Chat Completions 兼容端点（豆包方舟 / DeepSeek / 通义 / Kimi 等）。
 */
export interface OpenAICompatibleModelOptions {
  /** API Key（从环境变量或 .env 读入，不写死在代码里）。 */
  apiKey: string;
  /** OpenAI 兼容端点，如 https://ark.cn-beijing.volces.com/api/v3 */
  baseURL: string;
  /** 模型名或接入点 ID，如 doubao-seed-1.6-250615 / ep-xxxx。 */
  model: string;
  /** 默认温度；请求自带 temperature 时以请求为准。 */
  temperature?: number;
  /** 默认最大输出 token。 */
  maxTokens?: number;
  /** 请求超时（毫秒），默认 180_000（3 分钟）。长输入+结构化输出生成量大，90 秒常不够。 */
  timeoutMs?: number;
  /** 是否启用 json_object 响应模式（部分兼容端点支持），默认关闭以保最大兼容。 */
  jsonMode?: boolean;
}

/**
 * OpenAI 兼容模型适配器：把 ModelClient 的 ChatRequest 翻译成
 * OpenAI Chat Completions 请求，用 Node 内置 fetch 发起 HTTP 调用。
 * 只实现 ModelClient 契约，不改变业务层（Agent）任何逻辑。
 */
export class OpenAICompatibleModel implements ModelClient {
  private readonly options: OpenAICompatibleModelOptions;

  constructor(options: OpenAICompatibleModelOptions) {
    if (!options.apiKey || !options.baseURL || !options.model) {
      throw new Error("OpenAICompatibleModel 必须提供 apiKey / baseURL / model");
    }
    this.options = options;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: request.messages,
      temperature: request.temperature ?? this.options.temperature ?? 0.2,
    };
    const maxTokens = request.maxTokens ?? this.options.maxTokens;
    if (maxTokens !== undefined) {
      body.max_tokens = maxTokens;
    }
    if (this.options.jsonMode === true) {
      body.response_format = { type: "json_object" };
    }

    const timeoutMs = this.options.timeoutMs ?? 180_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.options.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new ModelCallError(`模型接口返回 ${response.status}：${text.slice(0, 500)}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new ModelCallError("模型接口返回了空内容");
      }
      return { content };
    } catch (error) {
      if (error instanceof ModelCallError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ModelCallError(`模型请求超时（${timeoutMs}ms）`);
      }
      throw new ModelCallError(
        `模型请求失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
