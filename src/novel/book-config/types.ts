/**
 * novel/book-config：书籍配置固化（Book Config）。
 * 对应建书第 2 步：把创意草案中的「运行参数」抽出来固化成 BookConfig + bookId。
 *
 * 关键区分（文档 N2）：单章字数、平台、语言属于运行参数，不属于世界设定；
 * 运行参数改了（如番茄→起点、2500→3000 字），世界设定不需要跟着改。
 *
 * N2 是纯程序节点（不调 LLM）：N1 已把文本理解成结构化字段，这里只做确定性转换。
 */

/** 题材编码（拼音，如 都市→dushi），见 mapping.ts 映射表。 */
export type Genre = string;

/** 平台编码（拼音，如 番茄→fanqie），见 mapping.ts 映射表。 */
export type Platform = string;

/** 书籍配置：书与项目运行参数。 */
export interface BookConfig {
  /** 书籍唯一标识（从书名生成的拼音 ID，如 隐龙→yinlong）。 */
  bookId: string;
  title: string;
  genre: Genre;
  platform: Platform;
  /** 目标章节数：用于计算全书阶段（opening/middle/late）。 */
  targetChapters: number;
  /** 单章字数，如番茄 2500。 */
  chapterWordCount: number;
  language: string;
  /** 章节审查模式：auto=自动审查，manual=人工审查。 */
  chapterReviewMode: "auto" | "manual";
  /** 审计不过时的重写预算，默认 2。 */
  maxHookRetries: number;
  createdAt: string;
  updatedAt: string;
}
