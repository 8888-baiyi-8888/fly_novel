import { join, sep } from "node:path";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { BaseMemory } from "../core/base-memory.js";
import type { CharacterScene } from "./types.js";

/** 一次完整的角色反应单元。 */
export interface CharacterReactionMemory {
  /** 用于跨场景文件按写入顺序合并历史。 */
  readonly createdAt: string;

  /** 本轮所属场景的稳定 ID。 */
  readonly sceneId: string;

  /** 导演提供给角色的本轮已知信息。 */
  readonly input: CharacterScene;

  /** 已通过调用方 Zod Schema 校验的角色响应。 */
  readonly output: Readonly<Record<string, unknown>>;
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
    storyId: string,
    branchId: string,
    characterId: string,
    sceneId: string,
    memoryRoot: string,
  ): Promise<CharacterMemory> {
    const safeStoryId = requireSafeId(storyId, "storyId");
    const safeBranchId = requireSafeId(branchId, "branchId");
    const safeCharacterId = requireSafeId(characterId, "characterId");
    const safeSceneId = requireSafeId(sceneId, "sceneId");
    const filePath = join(
      memoryRoot,
      safeStoryId,
      "character_agent",
      safeBranchId,
      safeCharacterId,
      "memory",
      `${safeSceneId}.json`,
    );
    const records = await BaseMemory.load<CharacterReactionMemory>(filePath);

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

  /** 将合并后的跨场景记忆转换为模型消息历史。 */
  static toMessages(records: readonly CharacterReactionMemory[]): BaseMessage[] {
    return records.flatMap(({ input, output }) => [
      new HumanMessage(`历史场景：${JSON.stringify(input)}`),
      new AIMessage(JSON.stringify(output)),
    ]);
  }

  /** 读取当前角色在所有场景文件中的记忆，并按写入时间合并。 */
  static async loadAll(
    storyId: string,
    branchId: string,
    characterId: string,
    memoryRoot: string,
  ): Promise<readonly CharacterReactionMemory[]> {
    const safeStoryId = requireSafeId(storyId, "storyId");
    const safeBranchId = requireSafeId(branchId, "branchId");
    const safeCharacterId = requireSafeId(characterId, "characterId");
    const memoryDirectory = join(memoryRoot, safeStoryId, "character_agent", safeBranchId, safeCharacterId, "memory");
    const currentFiles = await readDirectory(memoryDirectory);
    const currentMemories = await Promise.all(currentFiles
      .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
      .map(async entry => {
        const sceneId = requireSafeId(entry.name.slice(0, -5), "sceneId");
        const filePath = join(memoryDirectory, entry.name);
        const records = await BaseMemory.load<CharacterReactionMemory>(filePath);
        return records.map(record => ({ ...record, sceneId }));
      }));
    return currentMemories.flat().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

async function readDirectory(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function requireSafeId(characterId: string, field: string): string {
  if (
    characterId.trim() === ""
    || characterId === "."
    || characterId === ".."
    || characterId.includes("/")
    || characterId.includes("\\")
    || characterId.includes(sep)
  ) {
    throw new TypeError(`${field} 必须是不包含路径分隔符的非空字符串。`);
  }
  return characterId;
}
