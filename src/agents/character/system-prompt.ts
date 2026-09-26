import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCharacterDataDirectory } from "../runtime/agent-runtime.js";
import type { CharacterAgentOptions } from "./types.js";

/** 从世界背景和角色个人信息文件构建系统提示词。 */
export function buildSystemPrompt(
  options: Pick<CharacterAgentOptions, "storyId" | "branchId" | "characterId">,
): string {
  const dataDirectory = getCharacterDataDirectory();
  if (dataDirectory === undefined) {
    throw new Error("尚未配置角色数据目录。");
  }
  const storyDirectory = join(dataDirectory, options.storyId);
  const worldBackgroundPath = join(storyDirectory, "world-background.md");
  const characterInfoPath = join(
    storyDirectory,
    "character_agent",
    options.branchId ?? "main",
    options.characterId,
    "profile.md",
  );
  const worldBackground = readFileSync(worldBackgroundPath, "utf8").trim();
  const characterInfo = readFileSync(characterInfoPath, "utf8").trim();
  if (worldBackground === "") {
    throw new Error("世界背景文件内容不能为空。");
  }
  if (characterInfo === "") {
    throw new Error("角色个人信息文件内容不能为空。");
  }
  return `世界背景信息：\n${worldBackground}\n\n角色个人信息：\n${characterInfo}`;
}
