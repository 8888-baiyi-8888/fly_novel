import { ChatRequest, ChatResponse, ModelClient } from "../adapters/model-contract";
import { StoryArchitecture } from "../architecture/types";
import { buildState0Messages, buildState0RetryMessage } from "./prompt";
import { STATE0_JSON_DESCRIPTION } from "./schema";
import { parseState0Output, validateHookSeeds, validateHookSeedsAgainstBeatBoard } from "./validate";
import { State0 } from "./types";

export interface State0AgentOptions {
  model: ModelClient;
  /** 结构化输出校验失败后的重试次数，默认 1。 */
  maxRetries?: number;
}

/** N6 失败。 */
export class State0Error extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "State0Error";
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 程序兜底：模型漏给 characterStates（空/缺失）时，用 N5 角色卡自动生成默认状态，保证 N6 不崩。
 *  正符合协议「每张角色卡至少一条」；其他字段仍走正常校验。 */
function ensureCharacterStates(parsed: unknown, architecture: StoryArchitecture): unknown {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return parsed;
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.characterStates) && obj.characterStates.length > 0) return parsed;
  obj.characterStates = architecture.characterCards.map((card) => ({
    name: card.name,
    location: "故事起始地（正文待细化）",
    identity: card.archetype && card.archetype.length > 0 ? card.archetype : card.name,
    emotion: "平静",
    cognition: "见故事圣经设定",
    resources: "见故事圣经设定",
  }));
  return parsed;
}

/**
 * State₀ Agent（N6）：一次模型调用，把 N5 五件套转成六类初始运行状态。
 * bookId/title 从输入架构直接取（确定性，与 N5 一致）。
 */
export class State0Agent {
  private readonly model: ModelClient;
  private readonly maxRetries: number;

  constructor(options: State0AgentOptions) {
    this.model = options.model;
    this.maxRetries = options.maxRetries ?? 1;
  }

  /** 生成 State₀。 */
  async createState0(architecture: StoryArchitecture): Promise<State0> {
    const lineIds = architecture.threadMap.lines.map((line) => line.id);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const request: ChatRequest = {
          messages:
            attempt === 0
              ? buildState0Messages(architecture)
              : [...buildState0Messages(architecture), buildState0RetryMessage(describeError(lastError))],
          structured: { name: "state0", description: STATE0_JSON_DESCRIPTION },
          temperature: 0.2,
        };
        const response: ChatResponse = await this.model.chat(request);
        const parsed: unknown = JSON.parse(response.content);
        const state0 = parseState0Output(ensureCharacterStates(parsed, architecture), lineIds);
        const violations = validateHookSeeds(state0.hookSeeds);
        // 区分硬失败与 warning：超最大活跃是硬失败（重试）；档位配比偏差是 warning（文档 13.1，不重试）
        const hardViolations = violations.filter((v) => !v.startsWith("[warning]"));
        if (hardViolations.length > 0) {
          throw new State0Error(`伏笔种子登记校验未通过：\n${hardViolations.join("\n")}`);
        }
        if (violations.length > 0) {
          console.warn(`N6 伏笔种子 warning（不阻断，仅提示）：\n${violations.join("\n")}`);
        }
        // 伏笔种子 ↔ 节拍板对账（硬规则）："得在后面能回收才能入账"
        const beatViolations = validateHookSeedsAgainstBeatBoard(state0.hookSeeds, architecture.beatBoard.beats);
        if (beatViolations.length > 0) {
          throw new State0Error(`伏笔种子对账校验未通过：\n${beatViolations.join("\n")}`);
        }
        return {
          ...state0,
          bookId: architecture.bookId,
          title: architecture.title,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new State0Error(`State₀ 生成失败：${describeError(lastError)}`);
  }
}
