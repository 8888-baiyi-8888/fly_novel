import type { BookId } from './identifiers.ts'

/**
 * 目标平台，决定 Censor 规则集、节奏与伏笔密度参数（PlatformProfile）。
 * 2026-09-28 对接小说流：上游 BookConfig 使用原文（如「晋江文学城」），
 * 章节流不再强加拼音码表——放宽为 string，原文透传（拼音码表只是平台参数映射的中间层）。
 */
export type Platform = string

/** 题材分类（同样对接上游原文，如「现代都市」；不设字面量枚举）。 */
export type Genre = string

/** 章节审阅模式：auto=审计不过自动重写，manual=挂起等待人工。 */
export type ChapterReviewMode = 'auto' | 'manual'

/** 书与项目配置（文档 §3.1）。运行参数，不属世界设定。 */
export interface BookConfig {
  readonly bookId: BookId
  readonly title: string
  readonly genre: Genre
  readonly platform: Platform
  /** 目标章节数，用于计算全书阶段（opening/middle/late）。 */
  readonly targetChapters: number
  /** 单章目标字数，如番茄 2500。 */
  readonly chapterWordCount: number
  readonly language: string
  readonly chapterReviewMode: ChapterReviewMode
  /** 审计不过时的重写预算，默认 2。 */
  readonly maxHookRetries: number
  readonly createdAt: string
  readonly updatedAt: string
}
