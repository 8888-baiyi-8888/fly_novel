import { BaseAgent } from "../core/base-agent.js";
import { resolveAgentModel } from "../runtime/agent-runtime.js";
import { runDeepAgent, type DeepAgentRunResult } from "../runtime/run-deep-agent.js";

/** 创建角色 Agent 时固定的角色定位。 */
export interface CharacterAgentOptions {
  /** 已注册模型的标识；省略时由 Agent 运行时选择默认模型。 */
  readonly modelId?: string;
  /** 小说身份。 */
  readonly storyId: string;
  /** 剧情分支身份；省略时由 Agent 运行时选择默认分支。 */
  readonly branchId?: string;
  /** 角色身份。 */
  readonly characterId: string;
}

/** 角色在本轮可见、可听到或已经获知的场景材料。 */
export type CharacterScene = Readonly<Record<string, unknown>>;

/** 本轮角色输出的范围与形式。 */
export interface CharacterOutputRequirements {
  readonly scope: string;
  readonly maxDialogueLines?: number;
  readonly maxActions?: number;
  readonly stopCondition?: string;
  readonly includeInnerActivity?: boolean;
}

/** 单次角色运行的业务输入。 */
export interface CharacterAgentRunInput {
  readonly scene: CharacterScene;
  readonly outputRequirements: CharacterOutputRequirements;
}

/** 单次角色运行的调用控制参数。 */
export interface CharacterAgentRunOptions {
  readonly signal?: AbortSignal;
}

function requireIdentifier(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${fieldName} 必须是非空字符串。`);
  }
  return value;
}

function createModelPrompt(input: CharacterAgentRunInput): string {
  return JSON.stringify({
    scene: input.scene,
    outputRequirements: input.outputRequirements,
  });
}

/**
 * 角色 Agent 的外部调用入口。
 *
 * 当前只把场景和输出要求交给 Deep Agents；记忆读取、角色提示、结构化结果校验和持久化尚未接入。
 */
export class CharacterAgent extends BaseAgent {
  readonly #options: Readonly<CharacterAgentOptions>;

  public constructor(options: CharacterAgentOptions) {
    super();
    const modelId = options.modelId === undefined ? undefined : requireIdentifier(options.modelId, "modelId");
    this.#options = Object.freeze({
      modelId,
      storyId: requireIdentifier(options.storyId, "storyId"),
      branchId: options.branchId === undefined ? undefined : requireIdentifier(options.branchId, "branchId"),
      characterId: requireIdentifier(options.characterId, "characterId"),
    });
  }

  /** 返回创建时固定的模型选择与角色定位。 */
  public get options(): Readonly<CharacterAgentOptions> {
    return this.#options;
  }

  /** 执行一次只包含场景与输出要求的 Deep Agents 调用。 */
  public async run(
    input: CharacterAgentRunInput,
    options: CharacterAgentRunOptions = {},
  ): Promise<DeepAgentRunResult> {
    const model = await resolveAgentModel(this.#options.modelId);
    return runDeepAgent(model, createModelPrompt(input), options.signal);
  }
}
