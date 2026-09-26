import { readFileSync } from "node:fs";
import { BaseAgent } from "../core/base-agent.js";
import { toolStrategy } from "langchain";
import { z } from "zod";
import type { SupportedResponseFormat } from "deepagents";
import { getCharacterMemoryDirectory, resolveAgentResources } from "../runtime/agent-runtime.js";
import { createModelAgent, runDeepAgent, type DeepAgentRunResult } from "../runtime/run-deep-agent.js";
import type { CharacterAgentOptions, CharacterAgentRunInput, CharacterAgentRunOptions, CharacterContextSection, CharacterScene } from "./types.js";
import { CharacterMemory, type CharacterReactionMemory } from "./memory.js";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
export type CharacterAgentRunResult<TOutput = Record<string, unknown>> = Omit<DeepAgentRunResult, "structuredResponse"> & {
  structuredResponse: TOutput;
};

interface CharacterRunContext {
  readonly memory: Promise<CharacterMemory> | undefined;
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
  readonly #memories = new Map<string, Promise<CharacterMemory>>();
  readonly system_prompts: string;
  #running = false;

  public constructor(options: CharacterAgentOptions) {
    super();
    this.#options = Object.freeze({
      modelId: options.modelId === undefined ? undefined : requireIdentifier(options.modelId, "modelId"),
      storyId: requireIdentifier(options.storyId, "storyId"),
      branchId: options.branchId === undefined ? "main" : requireIdentifier(options.branchId, "branchId"),
      characterId: requireIdentifier(options.characterId, "characterId"),
      worldBackgroundPath: requireIdentifier(options.worldBackgroundPath, "worldBackgroundPath"),
      characterInfoPath: requireIdentifier(options.characterInfoPath, "characterInfoPath"),
    });
    this.system_prompts = this.buildSystemPrompt();
  }
  private buildSystemPrompt(): string {
    const worldBackground = readFileSync(this.#options.worldBackgroundPath, "utf8").trim();
    const characterInfo = readFileSync(this.#options.characterInfoPath, "utf8").trim();
    if (worldBackground === "") {
      throw new Error("世界背景文件内容不能为空。");
    }
    if (characterInfo === "") {
      throw new Error("角色个人信息文件内容不能为空。");
    }
    return `世界背景信息：\n${worldBackground}\n\n角色个人信息：\n${characterInfo}`;
  }
  /** 固定的角色定位，供内部加载方法使用。 */
  public get options(): Readonly<CharacterAgentOptions> {
    return this.#options;
  }

  /** 返回该角色已持久化的全部记忆，不暴露本机存储路径。 */
  public async getAllMemories(): Promise<readonly CharacterReactionMemory[]> {
    const memoryRoot = getCharacterMemoryDirectory();
    if (memoryRoot === undefined) {
      throw new Error("Agent 运行时尚未配置角色记忆目录。");
    }
    return CharacterMemory.loadAll(
      this.#options.storyId,
      this.#options.branchId ?? "main",
      this.#options.characterId,
      memoryRoot,
    );
  }

  private getMemory(sceneId: string): Promise<CharacterMemory> | undefined {
    const memoryRoot = getCharacterMemoryDirectory();
    if (memoryRoot === undefined) {
      return undefined;
    }
    let memory = this.#memories.get(sceneId);
    if (memory === undefined) {
      memory = CharacterMemory.create(
        this.#options.storyId,
        this.#options.branchId ?? "main",
        this.#options.characterId,
        sceneId,
        memoryRoot,
      );
      this.#memories.set(sceneId, memory);
    }
    return memory;
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

    const prompt = await this.buildModelPrompt(input);
    const memory = this.getMemory(input.sceneId);
    const memoryRoot = getCharacterMemoryDirectory();
    const previousMemories = memoryRoot === undefined
      ? []
      : await CharacterMemory.loadAll(
        this.#options.storyId,
        this.#options.branchId ?? "main",
        this.#options.characterId,
        memoryRoot,
      );

    return {
      memory,
      responseFormat: toolStrategy(
        z.toJSONSchema(input.responseFormat),
        { handleError: false },
      ),
      messages: [
        ...CharacterMemory.toMessages(previousMemories),
        new HumanMessage(prompt),
      ],
    };
  }

  /** 校验模型结构化输出；仅将校验通过的结果写入记忆。 */
  private async finalizeRun<TSchema extends z.ZodObject>(
    input: CharacterAgentRunInput<TSchema>,
    memory: Promise<CharacterMemory> | undefined,
    result: DeepAgentRunResult,
  ): Promise<CharacterAgentRunResult<z.output<TSchema>>> {
    if (result.structuredResponse === undefined) {
      throw new Error("模型未返回结构化响应；请确认模型支持并执行了本轮输出工具调用。");
    }
    const structuredResponse = input.responseFormat.parse(result.structuredResponse);

    if (memory !== undefined) {
      await (await memory).append({
        createdAt: new Date().toISOString(),
        sceneId: input.sceneId,
        input: input.scene,
        output: structuredResponse,
      });
    }

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
