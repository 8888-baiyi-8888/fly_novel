import { BaseAgent } from "../core/base-agent.js";
import { toolStrategy } from "langchain";
import { z } from "zod";
import type { SupportedResponseFormat } from "deepagents";
import { resolveAgentResources } from "../runtime/agent-runtime.js";
import { createModelAgent, runDeepAgent, type DeepAgentRunResult } from "../runtime/run-deep-agent.js";
import type { CharacterAgentOptions, CharacterAgentRunInput, CharacterAgentRunOptions } from "./types.js";
import { CharacterMemory, type CharacterReactionMemory } from "./memory.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
export type CharacterAgentRunResult<TOutput = Record<string, unknown>> = Omit<DeepAgentRunResult, "structuredResponse"> & {
  structuredResponse: TOutput;
};

interface CharacterRunContext {
  readonly memory: CharacterMemory;
  readonly messages: BaseMessage[];
  readonly responseFormat: SupportedResponseFormat;
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} 必须是非空字符串。`);
  }
  return value;
}

/** 调用 Deep Agent 并校验响应结构；历史仅来自角色持久记忆。 */
export class CharacterAgent extends BaseAgent {
  readonly #options: Readonly<CharacterAgentOptions>;
  readonly #memory: Promise<CharacterMemory>;
  readonly system_prompts: string;
  #running = false;

  public constructor(options: CharacterAgentOptions) {
    super();
    this.#options = Object.freeze({
      modelId: options.modelId === undefined ? undefined : requireIdentifier(options.modelId, "modelId"),
      storyId: requireIdentifier(options.storyId, "storyId"),
      branchId: options.branchId === undefined ? "main" : requireIdentifier(options.branchId, "branchId"),
      characterId: requireIdentifier(options.characterId, "characterId"),
    });
    this.system_prompts = buildSystemPrompt(this.#options);
    this.#memory = CharacterMemory.create({
      storyId: this.#options.storyId,
      branchId: this.#options.branchId ?? "main",
      characterId: this.#options.characterId,
    });
  }
  /** 固定的角色定位，供内部加载方法使用。 */
  public get options(): Readonly<CharacterAgentOptions> {
    return this.#options;
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
      this.system_prompts,
      () => responseFormat,
    );

    return await runDeepAgent(
      agent,
      messages,
      options.signal,
    );
  }

  /** 验证调用输入，并准备本轮模型调用所需的记忆、消息与输出策略。 */
  private async prepareRun(input: CharacterAgentRunInput): Promise<CharacterRunContext> {
    requireIdentifier(input.sceneId, "sceneId");
    if (!(input.responseFormat instanceof z.ZodObject)) {
      throw new TypeError("responseFormat 必须是调用方提供的 Zod 对象 Schema。");
    }

    const scene = input.scene;
    const memory = await this.#memory;

    return {
      memory,
      responseFormat: toolStrategy(
        z.toJSONSchema(input.responseFormat),
        { handleError: false },
      ),
      messages: [
        ...memory.toMessages(),
        new HumanMessage(scene),
      ],
    };
  }

  /** 校验模型结构化输出；仅将校验通过的结果写入记忆。 */
  private async finalizeRun<TSchema extends z.ZodObject>(
    input: CharacterAgentRunInput<TSchema>,
    memory: CharacterMemory,
    result: DeepAgentRunResult,
  ): Promise<CharacterAgentRunResult<z.output<TSchema>>> {
    if (result.structuredResponse === undefined) {
      throw new Error("模型未返回结构化响应；请确认模型支持并执行了本轮输出工具调用。");
    }
    const structuredResponse = input.responseFormat.parse(result.structuredResponse);

    const record: CharacterReactionMemory = {
      createdAt: new Date().toISOString(),
      sceneId: input.sceneId,
      input: input.scene,
      output: structuredResponse,
    };
    await memory.append(input.sceneId, record);

    return {
      ...result,
      structuredResponse,
    } as CharacterAgentRunResult<z.output<TSchema>>;
  }

  /**
   * 执行一次角色反应；同一实例不允许并发运行。
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
      const context = await this.prepareRun(input);
      options.signal?.throwIfAborted();
      const result = await this.generateReaction(
        context.messages,
        context.responseFormat,
        options,
      );
      return this.finalizeRun(input, context.memory, result);
    } catch (error) {
      console.error("CharacterAgent 运行失败：", error);
      throw error;
    } finally {
      this.#running = false;
    }
  }
}
