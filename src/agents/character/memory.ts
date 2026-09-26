import { join, sep } from "node:path";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { BaseMemory } from "../core/base-memory.js";
import type { CharacterScene } from "./types.js";

/** 一次完整的角色反应单元。 */
export interface CharacterReactionMemory {
  /** 导演提供给角色的本轮已知信息。 */
  input: CharacterScene;

  /** 已通过调用方 Zod Schema 校验的角色响应。 */
  output: Readonly<Record<string, unknown>>;
}

/**
 * 角色记忆。
 *
 * 保存角色经历过的完整反应单元，并在 Agent 执行时
 * 将其转换为 LangChain / Deep Agents 使用的消息历史。
 */
export class CharacterMemory extends BaseMemory<CharacterReactionMemory> {
  readonly #characterId: string;

  private constructor(
    characterId: string,
    filePath: string,
    records: CharacterReactionMemory[],
  ) {
    super(filePath, records);
    this.#characterId = characterId;
  }

  /**
   * 创建角色记忆。
   *
   * 创建时从本地文件恢复已有记忆；
   * 后续记忆保存在内存中，不需要重复读取文件。
   */
  static async create(
    characterId: string,
    baseDir: string,
  ): Promise<CharacterMemory> {
    const safeCharacterId = requireSafeCharacterId(characterId);
    const filePath = join(baseDir, `${safeCharacterId}.json`);

    const records =
      await BaseMemory.load<CharacterReactionMemory>(filePath);

    return new CharacterMemory(
      safeCharacterId,
      filePath,
      records,
    );
  }

  /** 当前记忆所属的角色 ID。 */
  get characterId(): string {
    return this.#characterId;
  }

  /**
   * 将角色记忆转换为模型可直接使用的消息历史。
   *
   * 每个角色反应单元转换为：
   * - input  -> HumanMessage
   * - output -> AIMessage
   */
  toMessages(): BaseMessage[] {
    return this.records.flatMap(({ input, output }) => [
      new HumanMessage(`历史场景：${JSON.stringify(input)}`),
      new AIMessage(JSON.stringify(output)),
    ]);
  }
}

function requireSafeCharacterId(characterId: string): string {
  if (
    characterId.trim() === ""
    || characterId === "."
    || characterId === ".."
    || characterId.includes("/")
    || characterId.includes("\\")
    || characterId.includes(sep)
  ) {
    throw new TypeError("characterId 必须是不包含路径分隔符的非空字符串。");
  }
  return characterId;
}
