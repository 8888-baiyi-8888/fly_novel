import { ChatRequest, ChatResponse, ModelClient } from "../../harness/model/contract";
import { BookConfig } from "../book-config/types";
import { CreativeDraft } from "../draft/types";
import { buildArchitectMessages, buildArchitectRetryMessage } from "./prompt";
import { parseArchitectOutput } from "./validate";
import { ARCHITECT_JSON_DESCRIPTION } from "./schema";
import { AI_REDLINES } from "./ai-redlines";
import { BookRules, StoryBible } from "./types";

export interface ArchitectAgentOptions {
  model: ModelClient;
  /** 结构化输出校验失败后的重试次数，默认 1（即最多共 2 次尝试）。 */
  maxRetries?: number;
}

/** 架构师基础设定失败（多次重试后仍无法得到合法输出）。 */
export class ArchitectError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArchitectError";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 组装带编号的书籍规则：R01…（书特定）+ A01…（内置 AI 红线）。 */
export function buildBookRules(bookId: string, title: string, generated: { content: string }[]): BookRules {
  const storyRules = generated.map((rule, index) => ({
    id: `R${String(index + 1).padStart(2, "0")}`,
    category: "story" as const,
    content: rule.content,
  }));
  const redlineRules = AI_REDLINES.map((content, index) => ({
    id: `A${String(index + 1).padStart(2, "0")}`,
    category: "ai-redline" as const,
    content,
  }));
  return { bookId, title, rules: [...storyRules, ...redlineRules] };
}

/**
 * 架构师 Agent（N3）：一次模型调用，根据创作简报 + 创意草案 + BookConfig
 * 产出故事圣经（sections）+ 书特定书籍规则；AI 写作红线由程序内置合并。
 */
export class ArchitectAgent {
  private readonly model: ModelClient;
  private readonly maxRetries: number;

  constructor(options: ArchitectAgentOptions) {
    this.model = options.model;
    this.maxRetries = options.maxRetries ?? 1;
  }

  /** 一次调用：返回 { storyBible, bookRules }（bookRules 已合并内置 AI 红线）。 */
  async createStoryFoundation(
    brief: string,
    draft: CreativeDraft,
    bookConfig: BookConfig,
  ): Promise<{ storyBible: StoryBible; bookRules: BookRules }> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const request: ChatRequest = {
          // 第 1 次尝试用原消息；重试时把"上次输出哪里不符合协议"追加为反馈，引导模型修正格式
          messages:
            attempt === 0
              ? buildArchitectMessages(brief, draft, bookConfig)
              : [
                  ...buildArchitectMessages(brief, draft, bookConfig),
                  buildArchitectRetryMessage(describeError(lastError)),
                ],
          structured: { name: "architect_foundation", description: ARCHITECT_JSON_DESCRIPTION },
          temperature: 0.2,
        };
        const response: ChatResponse = await this.model.chat(request);
        const parsed: unknown = JSON.parse(response.content);
        const { storyBible, bookRules } = parseArchitectOutput(parsed);
        return {
          storyBible: { bookId: bookConfig.bookId, title: bookConfig.title, sections: storyBible },
          bookRules: buildBookRules(bookConfig.bookId, bookConfig.title, bookRules),
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new ArchitectError(`架构师基础设定失败：${describeError(lastError)}`);
  }
}
