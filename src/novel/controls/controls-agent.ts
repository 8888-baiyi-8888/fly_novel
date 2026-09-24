import { ChatRequest, ChatResponse, ModelClient } from "../../harness/model/contract";
import { CreativeDraft } from "../draft/types";
import { slugifyTitle } from "../book-config/book-config";
import { buildControlsMessages, buildControlsRetryMessage } from "./prompt";
import { parseControlsOutput } from "./validate";
import { CONTROLS_JSON_DESCRIPTION } from "./schema";
import { LongTermControls } from "./types";

export interface ControlsAgentOptions {
  model: ModelClient;
  /** 结构化输出校验失败后的重试次数，默认 1（即最多共 2 次尝试）。 */
  maxRetries?: number;
}

/** 长期创作控制失败（多次重试后仍无法得到合法输出）。 */
export class ControlsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ControlsError";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 长期创作控制 Agent（N4）：一次模型调用，把草案中的创作意图部分
 * 整理扩展为四件套（作者意图/当前重点/分卷方向/创作约束）。
 * bookId 从书名确定性生成（与 N2 一致），因此 N4 与 N2/N3 并行、不依赖它们的产物。
 */
export class ControlsAgent {
  private readonly model: ModelClient;
  private readonly maxRetries: number;

  constructor(options: ControlsAgentOptions) {
    this.model = options.model;
    this.maxRetries = options.maxRetries ?? 1;
  }

  /** 一次调用：返回长期创作控制四件套。 */
  async createControls(draft: CreativeDraft): Promise<LongTermControls> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const request: ChatRequest = {
          // 第 1 次尝试用原消息；重试时把"上次输出哪里不符合协议"追加为反馈，引导模型修正格式
          messages:
            attempt === 0
              ? buildControlsMessages(draft)
              : [...buildControlsMessages(draft), buildControlsRetryMessage(describeError(lastError))],
          structured: { name: "creative_controls", description: CONTROLS_JSON_DESCRIPTION },
          temperature: 0.2,
        };
        const response: ChatResponse = await this.model.chat(request);
        const parsed: unknown = JSON.parse(response.content);
        const { authorIntent, currentFocus, volumeDirections, constraints } = parseControlsOutput(parsed);
        return {
          bookId: slugifyTitle(draft.title),
          title: draft.title,
          authorIntent,
          currentFocus,
          volumeDirections,
          constraints,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new ControlsError(`长期创作控制失败：${describeError(lastError)}`);
  }
}
