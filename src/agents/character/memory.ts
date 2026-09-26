import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { BaseMemory } from "../core/base-memory.js";
import { getCharacterMemoryDirectory } from "../runtime/agent-runtime.js";
import type { CharacterScene } from "./types.js";

export interface CharacterMemoryScope {
  readonly storyId: string;
  readonly branchId: string;
  readonly characterId: string;
}

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
 * 当前角色的完整记忆。
 *
 * 创建时一次性加载该角色所有场景的记忆；运行期间在内存中维护完整历史，
 * 新经历按场景归档到对应文件。
 */
export class CharacterMemory {
  readonly #scope: CharacterMemoryScope;
  readonly #memoryRoot: string | undefined;
  readonly #records: CharacterReactionMemory[];

  private constructor(
    scope: CharacterMemoryScope,
    memoryRoot: string | undefined,
    records: CharacterReactionMemory[],
  ) {
    this.#scope = scope;
    this.#memoryRoot = memoryRoot;
    this.#records = records;
  }

  /** 加载绑定角色的全部记忆；未配置持久化目录时从空记忆开始。 */
  static async create(scope: CharacterMemoryScope): Promise<CharacterMemory> {
    const safeScope = {
      storyId: requireSafeId(scope.storyId, "storyId"),
      branchId: requireSafeId(scope.branchId, "branchId"),
      characterId: requireSafeId(scope.characterId, "characterId"),
    };
    const memoryRoot = getCharacterMemoryDirectory();
    const records = memoryRoot === undefined
      ? []
      : await CharacterMemory.loadAll(safeScope, memoryRoot);
    return new CharacterMemory(safeScope, memoryRoot, [...records]);
  }

  /** 返回当前角色实例持有的完整记忆。 */
  getAll(): readonly CharacterReactionMemory[] {
    return this.#records;
  }

  /** 将完整记忆转换为模型消息历史。 */
  toMessages(): BaseMessage[] {
    return this.#records.flatMap(({ input, output }) => [
      new HumanMessage(`历史场景：${JSON.stringify(input)}`),
      new AIMessage(JSON.stringify(output)),
    ]);
  }

  /** 追加一段角色经历；场景 ID 只决定持久化文件，不筛选记忆历史。 */
  async append(sceneId: string, record: CharacterReactionMemory): Promise<void> {
    const safeSceneId = requireSafeId(sceneId, "sceneId");
    if (record.sceneId !== safeSceneId) {
      throw new TypeError("记忆记录的 sceneId 必须与归档场景一致。");
    }
    if (this.#memoryRoot !== undefined) {
      const sceneMemory = await CharacterSceneMemory.create(
        this.#scope,
        safeSceneId,
        this.#memoryRoot,
      );
      await sceneMemory.append(record);
    }
    this.#records.push(record);
  }

  /** 读取指定角色在持久化目录中的完整记忆。 */
  static async getAllMemories(
    scope: CharacterMemoryScope,
  ): Promise<readonly CharacterReactionMemory[]> {
    return (await CharacterMemory.create(scope)).getAll();
  }

  private static async loadAll(
    scope: CharacterMemoryScope,
    memoryRoot: string,
  ): Promise<readonly CharacterReactionMemory[]> {
    const memoryDirectory = join(
      memoryRoot,
      scope.storyId,
      "character_agent",
      scope.branchId,
      scope.characterId,
      "memory",
    );
    const currentFiles = await readDirectory(memoryDirectory);
    const currentMemories = await Promise.all(currentFiles
      .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
      .map(async entry => {
        const sceneId = requireSafeId(entry.name.slice(0, -5), "sceneId");
        const sceneMemory = await CharacterSceneMemory.createFromPath(
          scope.characterId,
          join(memoryDirectory, entry.name),
        );
        return sceneMemory.getAll().map(record => ({ ...record, sceneId }));
      }));
    return currentMemories.flat().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

class CharacterSceneMemory extends BaseMemory<CharacterReactionMemory> {
  private constructor(filePath: string, records: CharacterReactionMemory[]) {
    super(filePath, records);
  }

  static async create(
    scope: CharacterMemoryScope,
    sceneId: string,
    memoryRoot: string,
  ): Promise<CharacterSceneMemory> {
    const filePath = join(
      memoryRoot,
      scope.storyId,
      "character_agent",
      scope.branchId,
      scope.characterId,
      "memory",
      `${sceneId}.json`,
    );
    return CharacterSceneMemory.createFromPath(scope.characterId, filePath);
  }

  static async createFromPath(
    characterId: string,
    filePath: string,
  ): Promise<CharacterSceneMemory> {
    requireSafeId(characterId, "characterId");
    const records = await BaseMemory.load<CharacterReactionMemory>(filePath);
    return new CharacterSceneMemory(filePath, records);
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

function requireSafeId(value: string, field: string): string {
  if (
    value.trim() === ""
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes(sep)
  ) {
    throw new TypeError(`${field} 必须是不包含路径分隔符的非空字符串。`);
  }
  return value;
}
