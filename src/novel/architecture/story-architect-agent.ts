import { ChatRequest, ChatResponse, ModelClient } from "../../harness/model/contract";
import { BookRules, StoryBible } from "../architect/types";
import { LongTermControls } from "../controls/types";
import { CreativeDraft } from "../draft/types";
import { buildArchitectureMessages, buildArchitectureRetryMessage } from "./prompt";
import { ARCHITECTURE_JSON_DESCRIPTION } from "./schema";
import { parseArchitectureOutput } from "./validate";
import { ArchitectureParts } from "./types";

export interface StoryArchitectAgentOptions {
  model: ModelClient;
  /** 结构化输出校验失败后的重试次数，默认 1。 */
  maxRetries?: number;
}

/** 架构师（N5 前四件）失败。 */
export class StoryArchitectError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoryArchitectError";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 输入四份产物：草案 + 故事圣经 + 书籍规则 + 长期创作控制。 */
export interface ArchitectureInput {
  draft: CreativeDraft;
  storyBible: StoryBible;
  bookRules: BookRules;
  controls: LongTermControls;
}

/**
 * 架构师 Agent（N5 前四件）：一次模型调用，把四份输入组织成
 * 故事框架 / 分卷规划 / 角色卡 / 叙事线地图。
 */
export class StoryArchitectAgent {
  private readonly model: ModelClient;
  private readonly maxRetries: number;

  constructor(options: StoryArchitectAgentOptions) {
    this.model = options.model;
    this.maxRetries = options.maxRetries ?? 1;
  }

  /** 生成前四件。 */
  async createParts(input: ArchitectureInput): Promise<ArchitectureParts> {
    const { draft, storyBible, bookRules, controls } = input;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const request: ChatRequest = {
          messages:
            attempt === 0
              ? buildArchitectureMessages(draft, storyBible, bookRules, controls)
              : [
                  ...buildArchitectureMessages(draft, storyBible, bookRules, controls),
                  buildArchitectureRetryMessage(describeError(lastError)),
                ],
          structured: { name: "story_architecture", description: ARCHITECTURE_JSON_DESCRIPTION },
          temperature: 0.2,
        };
        const response: ChatResponse = await this.model.chat(request);
        const parsed: unknown = JSON.parse(response.content);
        return parseArchitectureOutput(parsed);
      } catch (error) {
        lastError = error;
      }
    }
    throw new StoryArchitectError(`架构师前四件生成失败：${describeError(lastError)}`);
  }
}
