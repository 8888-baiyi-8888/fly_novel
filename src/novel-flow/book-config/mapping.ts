/**
 * 题材/平台归一化（N2）。
 * 原设计：中文 → 拼音标识符（如 都市→dushi、番茄→fanqie，映射表见 git 历史），
 * 用户确认改为保留中文原文（更直观），因此这里只做「去空白 / 取首个有效项」。
 */

/** 归一化题材：取草案题材数组中第一个非空项（如 "都市"）；全部为空返回 "未定"。 */
export function normalizeGenre(genres: string[]): string {
  const hit = genres.find((raw) => raw.trim().length > 0);
  return hit === undefined ? "未定" : hit.trim();
}

/** 归一化平台：保留原文（如 "番茄"）；空串返回 "未定"。 */
export function normalizePlatform(platform: string): string {
  const trimmed = platform.trim();
  return trimmed.length > 0 ? trimmed : "未定";
}
