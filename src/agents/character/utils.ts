import path from "node:path"
import { readFileSync } from "node:fs"
import type { CharacterInfos } from "./types.js"
import type { CharacterAgentOptions } from "./types.js";
import { DEFAULT_BRANCH_ID } from "./types.js";
/**
 * 读取指定小说分支下的角色档案内容。
 *
 * 角色档案默认存储于：
 * `novel_data/{novelId}/character_agent/{branchId}/{characterId}/profile.md`
 *
 * @param novelId 小说唯一标识。
 * @param branchId 分支唯一标识。
 * @param characterId 角色唯一标识。
 * @param basePath 项目存储数据基础路径
 * @param fileName 存储文件名，默认 profile.md。
 * @returns 角色档案的 Markdown 文本内容。
 * @throws 当文件不存在、无读取权限或读取失败时抛出异常。
 */
export function getCharacterInfos(
  novelId: string,
  branchId: string,
  characterId: string,
  basePath: string,
  fileName?: string,
): CharacterInfos {
  const filePath = path.join(
    basePath,
    "novel_data",
    novelId,
    "character_agent",
    branchId,
    characterId,
    fileName ?? "profile.md",
  )

  return readFileSync(filePath, "utf-8")
}

export function resolveCharacterAgentOptions(
  options: CharacterAgentOptions,
): CharacterAgentOptions {
  let basePath = options.basePath ?? process.cwd()

  if (path.basename(basePath) !== ".fly-novel") {
    basePath = path.join(basePath, ".fly-novel")
  }

  return {
    ...options,
    branchId: options.branchId ?? DEFAULT_BRANCH_ID,
    basePath,
  }
}