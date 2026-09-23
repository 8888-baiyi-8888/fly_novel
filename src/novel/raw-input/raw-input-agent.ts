import { ChatRequest, ChatResponse, ModelClient } from "../../harness/model/contract";
import { buildRawInputMessages, buildRawInputRetryMessage } from "./prompt";
import { parseRawInput } from "./validate";
import { RAW_INPUT_JSON_DESCRIPTION } from "./schema";

export interface RawInputAgentOptions {
  model: ModelClient;
  /** 结构化输出校验失败后的重试次数，默认 1（即最多共 2 次尝试）。 */
  maxRetries?: number;
}

/** 原始输入整理失败（多次重试后仍无法得到合法文本）。 */
export class RawInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RawInputError";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 原始输入整理 Agent（N0）：单次模型调用，把用户几句粗糙想法扩展成一段完整的原始创作输入文本。
 * 不反问用户；主角、配角、主线、约束、平台篇幅等由模型自主补全。
 * 属于建书第 0 步的执行者；模型通过 ModelClient 注入，业务规则在 novel/raw-input。
 */
export class RawInputAgent {
  private readonly model: ModelClient;
  private readonly maxRetries: number;

  constructor(options: RawInputAgentOptions) {
    this.model = options.model;
    this.maxRetries = options.maxRetries ?? 1;
  }

  /** 单次调用：把用户初始想法扩展成一段完整原始创作输入文本。 */
  async createRawInput(initialInput: string): Promise<string> {
    const trimmed = initialInput.trim();
    if (trimmed.length === 0) {
      throw new RawInputError("初始想法为空，无法整理原始输入");
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const request: ChatRequest = {
          // 第 1 次尝试用原消息；重试时把"上次输出哪里不符合协议"追加为反馈，引导模型修正格式
          messages:
            attempt === 0
              ? buildRawInputMessages(trimmed)
              : [...buildRawInputMessages(trimmed), buildRawInputRetryMessage(describeError(lastError))],
          structured: { name: "raw_input", description: RAW_INPUT_JSON_DESCRIPTION },
          temperature: 0.2,
        };
        const response: ChatResponse = await this.model.chat(request);
        const parsed: unknown = JSON.parse(response.content);
        return parseRawInput(parsed);
      } catch (error) {
        lastError = error;
      }
    }
    throw new RawInputError(`原始输入整理失败：${describeError(lastError)}`);
  }
}
