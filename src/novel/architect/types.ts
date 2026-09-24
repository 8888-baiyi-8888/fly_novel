/**
 * novel/architect：架构师基础设定（Architect Foundation）。
 * 对应建书第 3 步：回答「这个世界是什么（故事圣经）+ 这本书允许怎么写（书籍规则）」。
 * 输入：BookConfig + 创作简报 + 创意草案；输出：故事圣经 + 书籍规则（含内置 AI 写作红线）。
 */

/** 故事圣经小节：一节一个主题（对应文档示例「一、当代背景」「二、龙王殿」……）。 */
export interface StoryBibleSection {
  /** 小节编号，如 "S01"。 */
  id: string;
  /** 主题名，如 "当代背景"。 */
  title: string;
  /** 该主题的事实描述：这个世界是什么样，长期稳定、不随章节变化。 */
  content: string;
}

/** 故事圣经：这本书的世界。 */
export interface StoryBible {
  bookId: string;
  title: string;
  sections: StoryBibleSection[];
}

/** 书籍规则条目：硬约束。 */
export interface BookRule {
  /** 编号："R01"（书特定规则）/ "A01"（内置 AI 写作红线）。 */
  id: string;
  /** 来源分类：story=架构师生成的书特定规则；ai-redline=内置 AI 写作红线。 */
  category: "story" | "ai-redline";
  content: string;
}

/** 书籍规则：这本书以后应该怎么写、哪些不能乱写（Director/Writer/Auditor 都读）。 */
export interface BookRules {
  bookId: string;
  title: string;
  rules: BookRule[];
}
