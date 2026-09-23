import { ChatMessage, ChatRequest, ChatResponse, ModelClient } from "../../harness/model/contract";
import {
  buildClarifyAnswerMessage,
  buildClarifyFinalMessage,
  buildClarifyMessages,
  buildClarifyQuestionsMessage,
  buildClarifyRetryMessage,
  buildDraftMessages,
} from "./prompt";
import { ClarificationTurn, parseAndValidateDraft, parseClarificationTurn } from "./validate";
import { CreativeDraft } from "./types";
import { CLARIFY_JSON_DESCRIPTION, DRAFT_JSON_DESCRIPTION } from "./schema";

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

/** 澄清问答回调：接收问题清单，返回用户回答（由调用方决定交互载体，如 CLI readline）。 */
export type ClarifyUserAnswer = (questions: string[]) => Promise<string>;

export interface CreateDraftWithClarificationOptions {
  /** 最多提问轮数，默认 3（达到后强制生成最终草案）。 */
  maxRounds?: number;
  /** 用户输入这些词视为提前结束，默认 ["够了","停止","就这样","不用了"]。 */
  stopWords?: string[];
}

function isStopWord(answer: string, stopWords: string[]): boolean {
  const trimmed = answer.trim();
  return trimmed.length > 0 && stopWords.includes(trimmed);
}

/** 把"模型提问轮残留的问题"并入草案 openQuestions（去重，不修改已存在的问题）。 */
function mergeRemainingQuestions(draft: CreativeDraft, questions: string[]): CreativeDraft {
  if (questions.length === 0) return draft;
  const existing = new Set(draft.openQuestions);
  const added = questions.filter((question) => !existing.has(question));
  if (added.length === 0) return draft;
  return { ...draft, openQuestions: [...draft.openQuestions, ...added] };
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

  /** 澄清式整理：先问后生成，最多 maxRounds 轮提问，最后输出完整草案。 */
  async createDraftWithClarification(
    rawInput: string,
    askUser: ClarifyUserAnswer,
    options: CreateDraftWithClarificationOptions = {},
  ): Promise<CreativeDraft> {
    const maxRounds = options.maxRounds ?? 3;
    const stopWords = options.stopWords ?? ["够了", "停止", "就这样", "不用了"];
    const trimmed = rawInput.trim();
    if (trimmed.length === 0) {
      throw new CreativeDraftError("原始输入为空，无法整理创意草案");
    }

    const messages: ChatMessage[] = buildClarifyMessages(trimmed);
    let rounds = 0;

    for (;;) {
      const turn = await this.callClarifyTurn(messages);
      if (turn.draft !== undefined) {
        // 模型给了草案：若仍有未决问题（本轮 questions 或草案 openQuestions）且还有提问预算 → 反问用户，而不是直接返回
        const remaining = [...turn.questions, ...turn.draft.openQuestions];
        if (remaining.length === 0 || rounds >= maxRounds) {
          return mergeRemainingQuestions(turn.draft, turn.questions);
        }
        const answer = await askUser(remaining);
        if (isStopWord(answer, stopWords)) {
          const finalTurn = await this.callClarifyTurn([
            ...messages,
            buildClarifyQuestionsMessage(remaining),
            buildClarifyAnswerMessage(answer),
            buildClarifyFinalMessage(),
          ]);
          if (finalTurn.draft === undefined) {
            throw new CreativeDraftError("用户提前结束但模型仍未给出草案");
          }
          return mergeRemainingQuestions(finalTurn.draft, finalTurn.questions);
        }
        messages.push(buildClarifyQuestionsMessage(remaining), buildClarifyAnswerMessage(answer));
        rounds += 1;
        continue;
      }
      if (rounds >= maxRounds) {
        const finalTurn = await this.callClarifyTurn([...messages, buildClarifyFinalMessage()]);
        if (finalTurn.draft === undefined) {
          throw new CreativeDraftError("澄清达到最大轮数后模型仍未给出草案");
        }
        return mergeRemainingQuestions(finalTurn.draft, finalTurn.questions);
      }
      const answer = await askUser(turn.questions);
      if (isStopWord(answer, stopWords)) {
        const finalTurn = await this.callClarifyTurn([
          ...messages,
          buildClarifyQuestionsMessage(turn.questions),
          buildClarifyAnswerMessage(answer),
          buildClarifyFinalMessage(),
        ]);
        if (finalTurn.draft === undefined) {
          throw new CreativeDraftError("用户提前结束但模型仍未给出草案");
        }
        return mergeRemainingQuestions(finalTurn.draft, finalTurn.questions);
      }
      messages.push(buildClarifyQuestionsMessage(turn.questions), buildClarifyAnswerMessage(answer));
      rounds += 1;
    }
  }

  /** 澄清轮模型调用：一次调用 + JSON 解析 + 澄清协议校验 + 失败重试（重试时携带上次错误反馈）。 */
  private async callClarifyTurn(messages: ChatMessage[]): Promise<ClarificationTurn> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const request: ChatRequest = {
          // 第 1 次尝试用原消息；重试时把"上次输出哪里不符合协议"追加为反馈，引导模型修正格式
          messages:
            attempt === 0 ? messages : [...messages, buildClarifyRetryMessage(describeError(lastError))],
          structured: { name: "clarification_turn", description: CLARIFY_JSON_DESCRIPTION },
          temperature: 0.2,
        };
        const response = await this.model.chat(request);
        const parsed: unknown = JSON.parse(response.content);
        return parseClarificationTurn(parsed);
      } catch (error) {
        lastError = error;
      }
    }
    throw new CreativeDraftError(`澄清轮整理失败：${describeError(lastError)}`);
  }
}
