import { ChatMessage, ChatRequest, ChatResponse, ModelClient } from "../adapters/model-contract";
import {
  buildClarifyAnswerMessage,
  buildClarifyFinalMessage,
  buildClarifyMessages,
  buildClarifyQuestionsMessage,
  buildClarifyRetryMessage,
  buildDraftMessages,
  buildDraftRetryMessage,
} from "./prompt";
import { ClarificationTurn, parseAndValidateDraft, parseClarificationTurn, patchDraftCompleteness } from "./validate";
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
          // 第 1 次用原消息；重试时把上次校验错误回喂，引导模型修正结构（部分模型结构性输出不稳）
          messages:
            attempt === 0
              ? buildDraftMessages(trimmed)
              : [...buildDraftMessages(trimmed), buildDraftRetryMessage(describeError(lastError))],
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
          return this.finalizeDraft(messages, remaining);
        }
        messages.push(buildClarifyQuestionsMessage(remaining), buildClarifyAnswerMessage(answer));
        rounds += 1;
        continue;
      }
      // 提问轮：模型给了问题列表但没给草案。若问题列表为空（如 {questions: [], draft: null}，
      // 模型认为信息够了却没给 draft）→ 不再问用户，直接强制交卷。
      if (turn.questions.length === 0) {
        return this.finalizeDraft(messages, []);
      }
      if (rounds >= maxRounds) {
        return this.finalizeDraft(messages, turn.questions);
      }
      const answer = await askUser(turn.questions);
      if (isStopWord(answer, stopWords)) {
        return this.finalizeDraft(messages, turn.questions);
      }
      messages.push(buildClarifyQuestionsMessage(turn.questions), buildClarifyAnswerMessage(answer));
      rounds += 1;
    }
  }

  /**
   * 强制交卷：追加"输出最终草案"指令让模型交卷。
   * 若模型仍不给草案（常见：反复输出 {questions: [], draft: null} 却不肯填 draft），
   * 降级为「直接草案输出」调用（去掉 questions/draft 包装协议），兜底保证澄清流程一定产出草案。
   */
  private async finalizeDraft(messages: ChatMessage[], leftoverQuestions: string[]): Promise<CreativeDraft> {
    const finalTurn = await this.callClarifyTurn([...messages, buildClarifyFinalMessage()]);
    if (finalTurn.draft !== undefined) {
      return mergeRemainingQuestions(finalTurn.draft, finalTurn.questions);
    }
    const leftover = [...leftoverQuestions, ...finalTurn.questions];
    return mergeRemainingQuestions(await this.callDraftFallback(messages), leftover);
  }

  /** 兜底：不带澄清包装，直接要求模型输出完整草案对象（模型最擅长的形态，基本必成）。 */
  private async callDraftFallback(messages: ChatMessage[]): Promise<CreativeDraft> {
    // 原逻辑（模型漏必填字段时直接抛错，如 volumePlan 空会中断整个澄清流程）：
    //   let lastError; for... try { ...return parseAndValidateDraft(JSON.parse(...));} catch{lastError=...}
    //   throw new CreativeDraftError(`澄清交卷失败：${lastError}`);
    // 修复：记录最近一次模型输出（可能只是缺必填字段的部分草案），重试结束后用程序兜底补全，
    // 保证澄清流程一定产出合法草案、不因单个必填字段（如 volumePlan）中断，同时保留用户澄清答案。
    let lastError: unknown;
    let lastParsed: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const request: ChatRequest = {
          messages: [
            ...messages,
            {
              role: "user",
              content:
                "澄清已结束。请直接输出完整创意草案 JSON 对象本身（不要 questions/draft 包装字段，直接按草案结构输出）。" +
                "所有必填字段必须填写完整：volumePlan 等数组字段必须为非空数组，分卷规划由你自主完成，每卷一条。",
            },
          ],
          structured: { name: "creative_draft", description: DRAFT_JSON_DESCRIPTION },
          temperature: 0.2,
        };
        const response = await this.model.chat(request);
        const parsed: unknown = JSON.parse(response.content);
        lastParsed = parsed;
        return parseAndValidateDraft(parsed);
      } catch (error) {
        lastError = error;
      }
    }
    if (lastParsed !== undefined && typeof lastParsed === "object" && lastParsed !== null && !Array.isArray(lastParsed)) {
      try {
        return patchDraftCompleteness(lastParsed as Record<string, unknown>);
      } catch {
        // 兜底补全仍失败则落回报错
      }
    }
    throw new CreativeDraftError(`澄清交卷失败：${describeError(lastError)}`);
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
