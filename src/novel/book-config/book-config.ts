import { pinyin } from "pinyin-pro";
import { CreativeDraft } from "../draft/types";
import { normalizeGenre, normalizePlatform } from "./mapping";
import { BookConfig } from "./types";

/**
 * 从书名生成拼音 bookId：声调去除、只保留小写字母与数字。
 * 例：隐龙 → "yinlong"；书名含数字/字母原样保留（如 "重生2010" → "zhongsheng2010"）。
 * 全部被过滤掉（如纯符号标题）时回退 "book"。
 */
export function slugifyTitle(title: string): string {
  const raw = pinyin(title, { toneType: "none", type: "array" }).join("");
  const slug = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug.length > 0 ? slug : "book";
}

/**
 * 书籍配置固化（N2）：从创意草案的运行参数部分生成 BookConfig。
 * 纯程序节点，不调 LLM；确定性输出（同一草案 → 同一 bookId）。
 * now 可注入，便于测试固定时间戳。
 */
export function buildBookConfig(draft: CreativeDraft, now: Date = new Date()): BookConfig {
  const timestamp = now.toISOString();
  return {
    bookId: slugifyTitle(draft.title),
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
