import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { StoryWorldProgressSource, WorldObjective } from './world-progress.js'

const id = z.string().uuid()
const text = z.string().trim().min(1)
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const timed = z.object({ kind: z.literal('timed'), durationMs: timestamp.min(1) }).strict()
const indefinite = z.object({ kind: z.literal('indefinite') }).strict()
export const enabledReviewPolicySchema = z.discriminatedUnion('kind', [timed, indefinite])
export const reviewPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('off') }).strict(), timed, indefinite,
])
const child = z.object({ id, description: text }).strict()
const option = z.object({ id: text, label: text, childIds: z.array(id).min(1) }).strict()
const dependency = z.object({ before: id, after: id }).strict()
const proposals = z.object({
  options: z.array(option).min(1),
  recommendedId: text,
  recommendationReason: text,
  dependencies: z.array(dependency).default([]),
}).strict()
const subject = z.object({
  runId: id, parentStoryId: id, batch: z.number().int().positive(), planHash: hash,
  goal: text, constraints: z.array(text), children: z.array(child).min(1), evidenceHash: hash,
}).strict()

const snapshot = subject.extend({
  formatVersion: z.literal(1), reviewId: id,
  policy: enabledReviewPolicySchema, openedAt: timestamp, deadline: timestamp.optional(),
  ...proposals.shape,
}).strict().superRefine((value, context) => {
  const ids = new Set(value.children.map(item => item.id))
  const orderKeys = new Set<string>()
  const optionIds = new Set<string>()
  const reject = (message: string) => context.addIssue({ code: 'custom', message })
  if (ids.size !== value.children.length || ids.has(value.parentStoryId)) reject('原安排的子故事身份无效')
  for (const { before, after } of value.dependencies) {
    if (!ids.has(before) || !ids.has(after) || before === after) reject('审阅顺序依赖身份无效')
  }
  for (const entry of value.options) {
    if (optionIds.has(entry.id) || orderKeys.has(entry.childIds.join(','))) reject('审阅选项重复')
    optionIds.add(entry.id)
    orderKeys.add(entry.childIds.join(','))
    const positions = new Map(entry.childIds.map((childId, i) => [childId, i]))
    if (positions.size !== ids.size || positions.size !== entry.childIds.length || !entry.childIds.every(childId => ids.has(childId))) reject('审阅选项必须包含同一批子故事')
    if (value.dependencies.some(({ before, after }) => positions.get(before)! >= positions.get(after)!)) reject('审阅选项违反推进依赖')
  }
  if (!optionIds.has(value.recommendedId)) reject('审阅推荐项不存在')
  if (value.deadline !== (value.policy.kind === 'timed' ? value.openedAt + value.policy.durationMs : undefined)) reject('审阅截止时间无效')
})
export const storyReviewSchema = snapshot.safeExtend({ version: hash }).refine(({ version, ...value }) => reviewDigest(value) === version, '审阅版本与正文不匹配')
export type StoryReview = z.infer<typeof storyReviewSchema>
export type StoryReviewPolicy = z.infer<typeof reviewPolicySchema>
export type StoryReviewSubject = z.infer<typeof subject>
export type StoryReviewProposals = z.input<typeof proposals>
export interface StoryReviewConfiguration {
  policy: StoryReviewPolicy
  /** 可信时钟，返回 Unix 毫秒。默认使用 Date.now。 */
  now?: () => number
  /** 应用提供可采用的顺序及约束，可省略以保留初步安排。 */
  propose?(subject: StoryReviewSubject): StoryReviewProposals | undefined
}

export async function reviewEvidenceHash(source?: StoryWorldProgressSource, objectives?: readonly WorldObjective[]): Promise<string> {
  const current = await source?.current()
  if (current && current.worldId !== source?.worldId) throw new Error('审阅的世界状态身份不匹配')
  return reviewDigest({ current, objectives })
}

export const reviewChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('select'), optionId: text }).strict(),
  z.object({ kind: z.literal('cancel') }).strict(),
])
const identity = { formatVersion: z.literal(1), reviewId: id, version: hash, decidedAt: timestamp }
export const storyReviewDecisionSchema = z.discriminatedUnion('source', [
  z.object({ ...identity, source: z.literal('user'), choice: reviewChoiceSchema }).strict(),
  z.object({ ...identity, source: z.literal('timeout'), choice: z.object({ kind: z.literal('select'), optionId: text }).strict(), deadline: timestamp }).strict(),
  z.object({ ...identity, source: z.literal('refresh'), nextBatch: z.number().int().positive() }).strict(),
])
export type StoryReviewDecision = z.infer<typeof storyReviewDecisionSchema>

export function reviewDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function reviewTime(now: () => number = Date.now): number {
  return timestamp.parse(now())
}

export function createReviewSnapshot(input: StoryReviewSubject, reviewId: string, policy: z.infer<typeof enabledReviewPolicySchema>, openedAt: number, alternatives?: StoryReviewProposals): StoryReview {
  const value = snapshot.parse({
    ...input, reviewId, policy, openedAt,
    ...(policy.kind === 'timed' ? { deadline: openedAt + policy.durationMs } : {}),
    formatVersion: 1,
    ...(alternatives ?? {
      options: [{ id: 'original', label: '继续初步安排', childIds: input.children.map(item => item.id) }],
      recommendedId: 'original', recommendationReason: '采用父导演保存的初步安排',
    }),
  })
  return storyReviewSchema.parse({ ...value, version: reviewDigest(value) })
}

/** 版本及时间条件与已保存的原始审阅快照绑定。 */
export function verifyReviewDecision(review: StoryReview, decision: StoryReviewDecision): void {
  if (decision.reviewId !== review.reviewId || decision.version !== review.version) throw new Error('审阅决定身份或版本不匹配')
  if (decision.decidedAt < review.openedAt) throw new Error('审阅决定早于等待开始')
  if (decision.source === 'refresh') {
    if (decision.nextBatch !== review.batch + 1) throw new Error('替代审阅批次无效')
    return
  }
  const { choice } = decision
  if (choice.kind === 'select' && !review.options.some(option => option.id === choice.optionId)) throw new Error('审阅选项不存在')
  if (decision.source === 'timeout') {
    if (decision.deadline !== review.deadline || decision.decidedAt < decision.deadline || decision.choice.optionId !== review.recommendedId) throw new Error('审阅超时决定不匹配')
  } else if (review.deadline !== undefined && decision.decidedAt >= review.deadline) {
    throw new Error('审阅已到截止时间')
  }
}
