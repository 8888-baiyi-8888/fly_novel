import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 基础本地记忆。
 *
 * 负责：
 * - 启动时从 JSON 文件恢复记忆
 * - 在内存中维护记忆
 * - 新增记忆后持久化到本地
 *
 * 不关心具体记忆内容。
 */
export abstract class BaseMemory<T> {
  readonly #filePath: string;

  /** 已加载到内存中的全部记忆。 */
  protected readonly records: T[];

  protected constructor(
    filePath: string,
    records: T[],
  ) {
    this.#filePath = filePath;
    this.records = records;
  }

  /** 从本地 JSON 文件读取已有记忆。 */
  protected static async load<T>(filePath: string): Promise<T[]> {
    await mkdir(dirname(filePath), { recursive: true });

    try {
      const content = await readFile(filePath, "utf8");

      const data = JSON.parse(content) as {
        records?: T[];
      };

      return Array.isArray(data.records)
        ? data.records
        : [];
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;

      // 文件不存在表示当前还没有任何记忆。
      if (nodeError.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  /** 直接读取内存中的全部记忆，不访问磁盘。 */
  getAll(): readonly T[] {
    return this.records;
  }

  /** 添加一条记忆并持久化。 */
  async append(record: T): Promise<void> {
    await this.persist([...this.records, record]);
    this.records.push(record);
  }

  /** 将当前内存中的记忆持久化到本地。 */
  protected async persist(records: readonly T[] = this.records): Promise<void> {
    const temporaryPath = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      JSON.stringify(
        {
          records,
        },
        null,
        2,
      ),
      "utf8",
    );
    await rename(temporaryPath, this.#filePath);
  }
}
