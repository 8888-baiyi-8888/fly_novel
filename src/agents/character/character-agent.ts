import { BaseAgent } from "../core/base-agent.js";
import { toolStrategy } from "langchain";
import { z } from "zod";
import type { SupportedResponseFormat } from "deepagents";
import { getCharacterMemoryDirectory, resolveAgentResources } from "../runtime/agent-runtime.js";
import { createModelAgent, runDeepAgent, type DeepAgentRunResult } from "../runtime/run-deep-agent.js";
import type { CharacterAgentOptions, CharacterAgentRunInput, CharacterAgentRunOptions, CharacterContextSection, CharacterScene } from "./types.js";
import { CharacterMemory, type CharacterReactionMemory } from "./memory.js";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
export type CharacterAgentRunResult<TOutput = Record<string, unknown>> = Omit<DeepAgentRunResult, "structuredResponse"> & {
  structuredResponse: TOutput;
};

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} 必须是非空字符串。`);
  }
  return value;
}

/** 调用 Deep Agent 并校验响应结构；历史仅来自角色持久记忆。 */
export class CharacterAgent extends BaseAgent {
  readonly #options: Readonly<CharacterAgentOptions>;
  #memory: Promise<CharacterMemory> | undefined;
  #running = false;

  public constructor(options: CharacterAgentOptions) {
    super();
    this.#options = Object.freeze({
      modelId: options.modelId === undefined ? undefined : requireIdentifier(options.modelId, "modelId"),
      storyId: requireIdentifier(options.storyId, "storyId"),
      branchId: options.branchId === undefined ? "main" : requireIdentifier(options.branchId, "branchId"),
      characterId: requireIdentifier(options.characterId, "characterId"),
    });
  }

  /** 固定的角色定位，供内部加载方法使用。 */
  public get options(): Readonly<CharacterAgentOptions> {
    return this.#options;
  }

  /** 返回该角色已持久化的全部记忆，不暴露本机存储路径。 */
  public async getAllMemories(): Promise<readonly CharacterReactionMemory[]> {
    const memory = this.getMemory();
    if (memory === undefined) {
      throw new Error("Agent 运行时尚未配置角色记忆目录。");
    }
    return (await memory).getAll();
  }

  private getMemory(): Promise<CharacterMemory> | undefined {
    const directory = getCharacterMemoryDirectory();
    if (directory === undefined) {
      return undefined;
    }
    this.#memory ??= CharacterMemory.create(this.#options.characterId, directory);
    return this.#memory;
  }

  /** 人物身份与背景接口；待接入角色档案。 */
  protected async loadProfile(): Promise<CharacterContextSection> {
    return { content: "" };
  }

  /** 当前目标、关系、身体与情绪接口；待接入状态读取。 */
  protected async loadState(): Promise<CharacterContextSection> {
    return { content: "" };
  }

  /** 按场景准备性格及关系模式；待接入性格资料。 */
  protected async loadPersonality(_scene: CharacterScene): Promise<CharacterContextSection> {
    return { content: "" };
  }

  /** 跳过空白片段，保留有效内容原文与顺序。 */
  protected combineContext(sections: readonly CharacterContextSection[]): string {
    return sections.filter(({ content }) => content.trim() !== "").map(({ content }) => content).join("\n\n");
  }

  /** 顺序准备内部资料并附加场景；输出结构通过框架 responseFormat 指定。 */
  protected async buildModelPrompt(input: CharacterAgentRunInput): Promise<string> {
    const sections = [
      await this.loadProfile(),
      await this.loadState(),
      await this.loadPersonality(input.scene),
    ];
    return this.combineContext([
      ...sections,
      { content: `场景：${JSON.stringify(input.scene)}` },
    ]);
  }

  /** 生成阶段；框架与模型错误直接传播。 */
  protected async generateReaction(
    messages: BaseMessage[],
    responseFormat: SupportedResponseFormat,
    options: CharacterAgentRunOptions,
  ): Promise<DeepAgentRunResult> {
    const { model } = await resolveAgentResources(this.#options.modelId);
    options.signal?.throwIfAborted();
    const agent = createModelAgent(
      model,
      "你扮演当前绑定的小说角色，根据自身资料、过去经历和当前场景作出反应。调用本轮结构化输出工具提交最终响应，参数遵循该工具的输出 Schema，不用普通文本代替工具调用。",
      () => responseFormat,
    );

    return await runDeepAgent(
      agent,
      messages,
      options.signal,
    );
  }

  /** 人物一致性等业务校验接口；run 仅校验输出结构，不调用此占位接口。 */
  protected async validateResult(_result: DeepAgentRunResult): Promise<void> {
    throw new Error("角色结果校验尚未实现。");
  }

  /** 校验后的记忆、状态更新与一致保存接口；未实现，run 不调用它。 */
  protected async saveExperienceAndState(_input: CharacterAgentRunInput, _result: DeepAgentRunResult): Promise<void> {
    throw new Error("角色经历与状态持久化尚未实现。");
  }

/**
 * 准备角色上下文与历史记忆并执行本轮反应；同一实例不允许并发运行。
 *
 * 执行失败时输出错误并将原异常继续抛给调用方；
 * 仅在响应通过 Schema 校验后更新角色经历与状态。
 *
 * @param input 当前场景及调用方定义的 Zod 输出 Schema。
 * @param options 本次调用选项。
 * @returns 框架运行状态及通过 Schema 校验的 structuredResponse。
 */
public async run<TSchema extends z.ZodObject>(
  input: CharacterAgentRunInput<TSchema>,
  options: CharacterAgentRunOptions = {},
): Promise<CharacterAgentRunResult<z.output<TSchema>>> {
  options.signal?.throwIfAborted();

  if (this.#running) {
    throw new Error(
      "同一个 CharacterAgent 不允许并发运行，请等待当前调用结束。",
    );
  }

  this.#running = true;

  try {
    const schema = input.responseFormat;

    if (!(schema instanceof z.ZodObject)) {
      throw new TypeError(
        "responseFormat 必须是调用方提供的 Zod 对象 Schema。",
      );
    }

    // 将调用方的字段约束和额外字段规则一并传给框架。
    const responseFormat = toolStrategy(
      z.toJSONSchema(schema),
      { handleError: false },
    );

    // 构建本轮角色上下文。
    const prompt = await this.buildModelPrompt(input);

    const memory = this.getMemory();

    // 每轮从持久记忆重建完整历史，避免保留另一份实例内会话状态。
    const messages: BaseMessage[] = [
      ...(memory === undefined ? [] : (await memory).toMessages()),
      new HumanMessage(prompt),
    ];

    options.signal?.throwIfAborted();

    const result = await this.generateReaction(
      messages,
      responseFormat,
      options,
    );

    // 先完成输出结构校验，校验失败的结果不得写入角色记忆。
    const structuredResponse = schema.parse(
      result.structuredResponse,
    );

    const validatedResult = {
      ...result,
      structuredResponse,
    } as CharacterAgentRunResult<z.output<TSchema>>;

    // 仅保存已通过结构校验的本轮输入与响应；失败或取消不产生记忆。
    if (memory !== undefined) {
      await (await memory).append({
        input: input.scene,
        output: structuredResponse,
      });
    }

    return validatedResult;
  } catch (error) {
    console.error("CharacterAgent 运行失败：", error);
    throw error;
  } finally {
    this.#running = false;
  }
}
}
