import { pinyin } from "pinyin-pro";
import { createHash } from "node:crypto";
import { CreativeDraft } from "../draft/types";
import { normalizeGenre, normalizePlatform } from "./mapping";
import { BookConfig } from "./types";

/**
 * 按书名生成默认 novelId：声调去除、只保留小写字母与数字。
 * 例：隐龙 → "yinlong"；书名含数字/字母原样保留（如 "重生2010" → "zhongsheng2010"）。
 * 全部被过滤掉（如纯符号标题）时回退 "book"。
 */
export function slugifyTitle(title: string): string {
  const raw = pinyin(title, { toneType: "none", type: "array" }).join("");
  const slug = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug.length > 0 ? slug : "book";
}

/** 生成同一小说内稳定的角色 ID：拼音便于识别，短哈希区分同音或同名角色。 */
export function generateCharacterId(novelId: string, name: string): string {
  const normalizedName = name.normalize("NFKC").trim();
  const pinyinSlug = slugifyTitle(normalizedName);
  const suffix = createHash("sha256").update(`${novelId}\0${normalizedName}`).digest("hex").slice(0, 12);
  return `c-${pinyinSlug}-${suffix}`;
}

/** 生成默认小说 ID：本地时间戳加书名拼音，格式为 YYYYMMDD-HHmmss-title。 */
export function generateNovelId(title: string, now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${timestamp}-${slugifyTitle(title)}`;
}

/**
 * 从创意草案的运行参数部分固化 BookConfig，由 draft 节点调用。
 * 纯程序节点，不调 LLM；未传入 novelId 时，按生成时间与书名生成默认 ID。
 * now 可注入，便于测试固定时间戳。
 */
export function buildBookConfig(draft: CreativeDraft, now: Date = new Date(), novelId?: string): BookConfig {
  const timestamp = now.toISOString();
  return {
    novelId: novelId ?? generateNovelId(draft.title, now),
    title: draft.title,
    genre: normalizeGenre(draft.genre),
    platform: normalizePlatform(draft.platform),
    targetChapters: draft.targetChapters,
    chapterWordCount: draft.chapterWordCount,
    language: draft.language,
    chapterReviewMode: "auto",
    maxHookRetries: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
