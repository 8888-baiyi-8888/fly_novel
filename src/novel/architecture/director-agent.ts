import { ChatRequest, ChatResponse, ModelClient } from "../../harness/model/contract";
import { CreativeDraft } from "../draft/types";
import { buildBeatBoardMessages, buildBeatBoardRetryMessage } from "./prompt";
import { BEAT_BOARD_JSON_DESCRIPTION } from "./schema";
import { parseBeatBoardOutput, validateBeatBoard } from "./validate";
import { ArchitectureParts, BeatBoard } from "./types";

export interface DirectorAgentOptions {
  model: ModelClient;
  /** 结构化输出校验失败后的重试次数，默认 1。 */
  maxRetries?: number;
}

/** Director（节拍板）失败。 */
export class DirectorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DirectorError";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Director Agent（N5 节拍板）：一次模型调用，把架构师前四件 + 创作简报
 * 细化成全书章级蓝图（beats，长度 = targetChapters），并过代码验收闸门。
 */
export class DirectorAgent {
  private readonly model: ModelClient;
  private readonly maxRetries: number;

  constructor(options: DirectorAgentOptions) {
    this.model = options.model;
    this.maxRetries = options.maxRetries ?? 1;
  }

  /** 生成节拍板。 */
  async createBeatBoard(draft: CreativeDraft, parts: ArchitectureParts): Promise<BeatBoard> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const request: ChatRequest = {
          messages:
            attempt === 0
              ? buildBeatBoardMessages(draft, parts)
              : [...buildBeatBoardMessages(draft, parts), buildBeatBoardRetryMessage(describeError(lastError))],
          structured: { name: "beat_board", description: BEAT_BOARD_JSON_DESCRIPTION },
          temperature: 0.2,
        };
        const response: ChatResponse = await this.model.chat(request);
        const parsed: unknown = JSON.parse(response.content);
        const beatBoard = parseBeatBoardOutput(parsed, draft.targetChapters);
        const violations = validateBeatBoard(beatBoard, draft.targetChapters);
        if (violations.length > 0) {
          throw new DirectorError(`节拍板验收闸门未通过：\n${violations.join("\n")}`);
        }
        return beatBoard;
      } catch (error) {
        lastError = error;
      }
    }
    throw new DirectorError(`节拍板生成失败：${describeError(lastError)}`);
  }
}
