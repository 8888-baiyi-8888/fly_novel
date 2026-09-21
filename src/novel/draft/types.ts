/**
 * novel/draft：创意草案（Creation Draft）。
 * 对应建书第 1 步：把用户散乱的自然语言想法整理成结构化草案。
 *
 * 字段对齐《小说级开发工作流文档-v2》节点 N1 的五类草案结构：
 *   Basics（书名/题材/平台/目标章节数/单章字数/语言）
 *   World（世界前提/补充设定）
 *   Characters（主角/配角）
 *   Conflict（核心冲突/简介/作者意图）
 *   Structure（分卷大纲/当前重点/创作约束）
 * 外加 openQuestions（待澄清问题）与 rawSummary（原文摘要）。
 */

/** 主角草案（只记录相对稳定的属性；当前位置、伤势等动态信息属于运行状态）。 */
export interface ProtagonistDraft {
  name: string;
  age?: number;
  /** 身份 / 职业，如「后端程序员」。 */
  identity?: string;
  /** 长期性格倾向，如「谨慎、理性」。 */
  traits?: string[];
  /** 核心需求。 */
  coreNeed?: string;
  /** 核心恐惧。 */
  coreFear?: string;
}

/** 配角草案（草案阶段配角信息少，只记确定下来的部分；name 必填，其余可选）。 */
export interface SupportingCastDraft {
  name: string;
  /** 身份 / 角色定位，如「修士调查者」。 */
  identity?: string;
  /** 长期性格倾向。 */
  traits?: string[];
  /** 与主角的关系，如「同事」「对手」。 */
  relation?: string;
}

/** 结构化创意草案。 */
export interface CreativeDraft {
  /** 草案 schema 版本，未来格式变化时用于迁移判断。 */
  schemaVersion: 1;
  /** 书名；用户未定时为 undefined。 */
  title?: string;
  /** 题材，如「都市修仙」，至少一个。 */
  genre: string[];
  protagonist?: ProtagonistDraft;
  supportingCast?: SupportingCastDraft[];
  /** 世界前提：一句话说明这个世界是什么样（World.worldPremise）。 */
  worldPremise?: string;
  /** 世界观要点 / 补充设定（World.settingNotes 语义）。 */
  setting?: string[];
  /** 核心冲突 / 核心主题（Conflict.conflictCore）。 */
  coreConflict?: string;
  /** 简介 / 一句话故事卖点（Conflict.blurb）。 */
  blurb?: string;
  /** 作者意图：作者为什么这样写（Conflict.authorIntent；N4 长期创作控制的输入来源）。 */
  authorIntent?: string;
  /** 期望风格，如「现实、慢热」。 */
  tone: string[];
  /** 卷规划（用户已表达的粗线条，如第一卷写什么）。 */
  volumePlan?: string[];
  /** 当前重点：最近一段时间主要解决什么（Structure.currentFocus）。 */
  currentFocus?: string[];
  /** 创作约束（不能写什么）。 */
  constraints?: string[];
  /** 目标平台（运行参数；第 2 步 N2 拆 BookConfig 用），如「番茄」。 */
  platform?: string;
  /** 目标章节数（运行参数）。 */
  targetChapters?: number;
  /** 单章字数（运行参数）。 */
  chapterWordCount?: number;
  /** 语言（运行参数），如 "zh"。 */
  language?: string;
  /** 整理时发现的待澄清问题，供后续人工确认阶段使用。 */
  openQuestions: string[];
  /** 原始输入要点摘要，防止结构化丢失细节。 */
  rawSummary: string;
}
