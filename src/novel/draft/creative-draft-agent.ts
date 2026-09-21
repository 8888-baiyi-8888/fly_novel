import { ChatRequest, ChatResponse, ModelClient } from "../../harness/model/contract";
import { buildDraftMessages } from "./prompt";
import { parseAndValidateDraft } from "./validate";
import { CreativeDraft } from "./types";
import { DRAFT_JSON_DESCRIPTION } from "./schema";

export interface CreativeDraftAgentOptions {
  model: ModelClient;
  /** 结构化输出校验失败后的重试次数，默认 1（即最多共 2 次尝试）。 */
  maxRetries?: number;
}

/** 创意草案整理失败（多次重试后仍无法得到合法草案）。 */
export class CreativeDraftError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CreativeDraftError";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 创意草案 Agent（轻量）：一次模型调用 + 结构化输出校验。
 * 属于建书第 1 步的执行者；模型通过 ModelClient 注入，业务规则在 novel/draft。
 */
export class CreativeDraftAgent {
  private readonly model: ModelClient;
  private readonly maxRetries: number;

  constructor(options: CreativeDraftAgentOptions) {
    this.model = options.model;
    this.maxRetries = options.maxRetries ?? 1;
  }

  /** 把用户原始输入整理为结构化创意草案。 */
  async createDraft(rawInput: string): Promise<CreativeDraft> {
    const trimmed = rawInput.trim();
    if (trimmed.length === 0) {
      throw new CreativeDraftError("原始输入为空，无法整理创意草案");
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const request: ChatRequest = {
          messages: buildDraftMessages(trimmed),
          structured: { name: "creative_draft", description: DRAFT_JSON_DESCRIPTION },
          temperature: 0.2,
        };
        const response: ChatResponse = await this.model.chat(request);
        const parsed: unknown = JSON.parse(response.content);
        return parseAndValidateDraft(parsed);
      } catch (error) {
        lastError = error;
      }
    }
    throw new CreativeDraftError(`整理失败：${describeError(lastError)}`);
  }
}
