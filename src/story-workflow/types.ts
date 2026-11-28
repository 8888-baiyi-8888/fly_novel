import { createHash, randomUUID } from 'node:crypto'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { storyWorldEvidenceSchema, worldObjectivesSchema } from './world-progress.js'
import { mapSceneNeedSchema, sceneMapEvidenceSchema } from './map-scene.js'
import { adoptedReviewSchema, enabledReviewPolicySchema, reviewDigest, storyReviewSchema } from './user-review.js'
import { isDeepStrictEqual } from 'node:util'

const text = z.string().trim().min(1)
const uuid = z.string().uuid()
const independentPlanInput = z.object({ task: text, facts: z.array(text), directions: z.array(text) }).strict()
const worldSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('delivery'), target: z.json() }).strict(),
  z.object({ kind: z.literal('catalog'), ownerAgentId: text, path: text, revision: uuid }).strict(),
  z.object({ kind: z.literal('fixed'), id: text }).strict(),
])
export const storyWorldContextSchema = z.object({
  worldId: text, deliveryId: uuid, deliveryVersion: text, reviewVersion: text,
  materials: z.array(z.object({
    category: z.enum(['setting', 'direction', 'current', 'event']), source: worldSource, version: text,
    content: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().refine(item => createHash('sha256').update(item.content).digest('hex') === item.digest, '故事资料摘要不匹配')).min(1),
  notes: z.array(text), uncovered: z.array(text),
  deferred: z.array(z.object({ id: uuid, target: z.json(), version: text, summary: text }).strict()),
}).strict()
export type StoryWorldContext = z.infer<typeof storyWorldContextSchema>
const worldPlanInput = independentPlanInput.extend({ world: storyWorldContextSchema })
export const planInputSchema = z.union([independentPlanInput, worldPlanInput])
const proposal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('planned'), events: z.array(text).min(1) }).strict(),
  z.object({ kind: z.literal('no_events'), reason: text }).strict(),
])
const outcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('planned'), events: z.array(z.object({ id: uuid, description: text }).strict()).min(1) }).strict(),
  z.object({ kind: z.literal('no_events'), reason: text }).strict(),
])
export const planRecordSchema = z.discriminatedUnion('formatVersion', [
  z.object({ formatVersion: z.literal(1), id: uuid, input: independentPlanInput, outcome }).strict(),
  z.object({ formatVersion: z.literal(2), id: uuid, input: worldPlanInput, outcome }).strict(),
]).superRefine((value, ctx) => {
  if (value.outcome.kind === 'planned') {
    const ids = value.outcome.events.map(event => event.id)
    if (new Set(ids).size !== ids.length || ids.includes(value.id)) ctx.addIssue({ code: 'custom', message: '规划身份重复' })
  }
})
export type PlanInput = z.infer<typeof planInputSchema>
export type PlanRecord = z.infer<typeof planRecordSchema>

/** 严格解析 JSON，拒绝重复键；输出必须通过所属 schema 校验。 */
export function parseStrictJson(source: string): unknown {
  const value: unknown = JSON.parse(source)
  if (parseDocument(source, { uniqueKeys: true }).errors.length) throw new Error('JSON 含重复键或无效结构')
  return value
}

/** 解析导演规划并由程序分配不同的运行与事件身份。 */
export function createPlanRecord(input: PlanInput, response: string, id: string = randomUUID()): PlanRecord {
  const validated = planInputSchema.parse(input)
  const result = proposal.parse(parseStrictJson(response))
  return planRecordSchema.parse({ formatVersion: 'world' in validated ? 2 : 1, id, input: validated,
    outcome: result.kind === 'planned'
      ? { kind: result.kind, events: result.events.map(description => ({ id: randomUUID(), description })) }
      : result })
}

export const taskSchema = z.object({ background: text, goal: text, constraints: z.array(text) }).strict()
export const simulationSchema = z.object({ kind: z.literal('simulation'), summary: text, changes: z.array(text), unresolved: z.array(text), evidence: text }).strict()
export const reportSchema = z.object({ summary: text, changes: z.array(text), unresolved: z.array(text), evidence: text }).strict()
export const simulationRecordSchema = z.object({ formatVersion: z.literal(1), collaborationId: uuid, planId: uuid, childStoryId: uuid,
  task: taskSchema, preparation: text, simulation: simulationSchema }).strict()
export type SimulationRecord = z.infer<typeof simulationRecordSchema>
export const collaborationSchema = z.object({ formatVersion: z.literal(1), id: uuid, parentStoryId: uuid, childStoryId: uuid,
  plan: planRecordSchema, task: taskSchema, preparation: text, simulation: simulationSchema, report: reportSchema, parentReceipt: text }).strict().superRefine((record, ctx) => {
  if (record.plan.outcome.kind !== 'planned' || !record.plan.outcome.events.some(event => event.id === record.childStoryId) ||
      new Set([record.id, record.parentStoryId, record.childStoryId, record.plan.id]).size !== 4) ctx.addIssue({ code: 'custom', message: '协作故事身份不匹配' })
})
export type StoryTask = z.infer<typeof taskSchema>
export type Simulation = z.infer<typeof simulationSchema>
export type Collaboration = z.infer<typeof collaborationSchema>

export const siblingRunSchema = z.object({ formatVersion: z.literal(1), planId: uuid, parentStoryId: uuid }).strict()
export const siblingDecisionSchema = z.object({ formatVersion: z.literal(1), planId: uuid, parentStoryId: uuid, childStoryId: uuid,
  decision: z.enum(['continue', 'adjust', 'cancel']), reason: text }).strict()
export const directorDecisionSchema = z.object({ decision: z.enum(['continue', 'adjust', 'cancel']), reason: text }).strict()
export type SiblingDecision = z.infer<typeof siblingDecisionSchema>

/** 多层推进的单个故事记录；父故事为空表示本轮根故事。 */
export const storyNodeSchema = z.object({
  formatVersion: z.literal(1), runId: uuid, storyId: uuid, parentStoryId: uuid.nullable(),
  description: text, task: taskSchema,
}).strict().superRefine((value, ctx) => {
  if (value.storyId === value.parentStoryId) ctx.addIssue({ code: 'custom', message: '故事不能是自己的父故事' })
})
export type StoryNode = z.infer<typeof storyNodeSchema>

export const sceneOrderSchema = z.number().int().positive()
export const sceneSetupInputSchema = z.object({
  order: sceneOrderSchema,
  situation: text,
  preparation: text,
}).strict()
export type SceneSetupInput = z.infer<typeof sceneSetupInputSchema>

const sceneSetupRecordFields = sceneSetupInputSchema.extend({
  runId: uuid,
  storyId: uuid,
  sceneId: text,
}).strict()
export const sceneSetupRecordSchema = z.discriminatedUnion('formatVersion', [
  sceneSetupRecordFields.extend({ formatVersion: z.literal(1) }),
  sceneSetupRecordFields.extend({ formatVersion: z.literal(2), mapEvidence: sceneMapEvidenceSchema }),
])
export type SceneSetupRecord = z.infer<typeof sceneSetupRecordSchema>

export const sceneResultInputSchema = z.object({
  status: z.enum(['completed', 'terminated', 'unresolved']),
  simulation: simulationSchema,
}).strict()
export type SceneResultInput = z.infer<typeof sceneResultInputSchema>

const sceneResultRecordFields = sceneResultInputSchema.extend({
  runId: uuid,
  storyId: uuid,
  sceneId: text,
}).strict()
export const sceneResultRecordSchema = z.discriminatedUnion('formatVersion', [
  sceneResultRecordFields.extend({ formatVersion: z.literal(1) }),
  sceneResultRecordFields.extend({ formatVersion: z.literal(2), interaction: z.object({ sequence: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }),
])
export type SceneResultRecord = z.infer<typeof sceneResultRecordSchema>

const directDecision = z.object({ kind: z.literal('direct'), preparation: text }).strict()
const mapDirectDecision = directDecision.extend({ mapNeed: mapSceneNeedSchema })
export const storyDecisionSchema = z.union([mapDirectDecision, z.discriminatedUnion('kind', [
  directDecision,
  z.object({ kind: z.literal('split'), children: z.array(text).min(1) }).strict(),
])])
const savedStoryDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), preparation: text }).strict(),
  z.object({ kind: z.literal('split'), children: z.array(z.object({ id: uuid, description: text }).strict()).min(1) }).strict(),
])
const assessmentFields = { reason: text, report: reportSchema }
const terminatedAssessmentSchema = z.object({ status: z.literal('terminated'), ...assessmentFields }).strict()
export const storyAssessmentSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('achieved'), ...assessmentFields }).strict(),
  z.object({ status: z.literal('unmet'), ...assessmentFields, adjustment: text }).strict(),
  terminatedAssessmentSchema,
])
export const storyAdvanceSchema = z.union([directorDecisionSchema, terminatedAssessmentSchema])
export const supplementProposalSchema = z.object({ status: z.literal('supplement'), reason: text, description: text }).strict()
export const storyCompletionSchema = z.union([storyAssessmentSchema, supplementProposalSchema])
const storyResultFields = { runId: uuid, storyId: uuid, kind: z.literal('result'), value: reportSchema, receipt: text }
const legacyStoryResultSchema = z.object({ formatVersion: z.literal(1), ...storyResultFields }).strict()
const sceneStoryResultSchema = z.object({ formatVersion: z.literal(2), ...storyResultFields, sceneIds: z.array(text).min(1) }).strict()
const worldStoryResultSchema = z.object({ formatVersion: z.literal(3), ...storyResultFields, sceneIds: z.array(text), worldEvidence: storyWorldEvidenceSchema }).strict()

export const storyStepSchema = z.union([
  z.object({ formatVersion: z.literal(1), runId: uuid, storyId: uuid, kind: z.literal('decision'), value: savedStoryDecisionSchema }).strict(),
  z.object({ formatVersion: z.literal(2), runId: uuid, storyId: uuid, kind: z.literal('decision'), value: mapDirectDecision }).strict(),
  z.object({ formatVersion: z.literal(1), runId: uuid, storyId: uuid, kind: z.literal('simulation'), value: simulationSchema }).strict(),
  legacyStoryResultSchema,
  sceneStoryResultSchema,
  worldStoryResultSchema,
  z.object({ formatVersion: z.literal(1), runId: uuid, storyId: uuid, kind: z.literal('assessment'), value: storyAssessmentSchema }).strict(),
  z.object({ formatVersion: z.literal(1), runId: uuid, storyId: uuid, kind: z.literal('supplement'),
    value: z.object({ id: uuid, description: text, reason: text }).strict() }).strict(),
])
export type StoryStep = z.infer<typeof storyStepSchema>
const completedStorySchema = z.union([
  legacyStoryResultSchema.extend({ assessment: storyAssessmentSchema.optional() }),
  sceneStoryResultSchema.extend({ assessment: storyAssessmentSchema.optional() }),
  worldStoryResultSchema.extend({ assessment: storyAssessmentSchema.optional() }),
])
export function storyProgressVersion(frames: readonly { results: readonly { formatVersion: 1 | 2 | 3 }[] }[]): 1 | 2 | 3 {
  if (frames.some(frame => frame.results.some(result => result.formatVersion === 3))) return 3
  return frames.some(frame => frame.results.some(result => result.formatVersion === 2)) ? 2 : 1
}
export const storyProgressSchema = z.object({
  formatVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  runId: uuid,
  batch: z.number().int().positive(),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  worldObjectives: worldObjectivesSchema.optional(),
  reviewPolicy: enabledReviewPolicySchema.optional(),
  review: storyReviewSchema.optional(),
  frames: z.array(z.object({
    node: storyNodeSchema,
    children: z.array(z.object({ id: uuid, description: text }).strict()).min(1),
    index: z.number().int().nonnegative(),
    results: z.array(completedStorySchema),
    decisions: z.array(directorDecisionSchema.extend({ description: text })),
    supplement: z.object({ id: uuid, description: text, reason: text }).strict().optional(),
    adoptedReview: adoptedReviewSchema.optional(),
  }).strict()).min(1),
}).strict().refine(
  value => {
    if (value.formatVersion !== 4) {
      return value.reviewPolicy === undefined && value.review === undefined && value.frames.every(frame => frame.adoptedReview === undefined) && value.formatVersion === storyProgressVersion(value.frames) &&
        (value.worldObjectives === undefined || value.formatVersion === 3)
    }
    if (!value.reviewPolicy) return false
    const review = value.review
    if (!review) return true
    const top = value.frames.at(-1)!
    return review.runId === value.runId && review.batch === value.batch && review.planHash === value.planHash &&
      review.evidenceHash === reviewDigest({ worldState: review.worldState, objectives: value.worldObjectives }) &&
      review.parentStoryId === top.node.storyId && review.goal === top.node.task.goal && isDeepStrictEqual(review.constraints, top.node.task.constraints) &&
      isDeepStrictEqual(review.policy, value.reviewPolicy) && isDeepStrictEqual(review.children, top.children) &&
      top.index === 0 && top.decisions.length === 0 && top.results.length === 0 && top.supplement === undefined && top.adoptedReview === undefined
  },
  { message: '暂停记录版本与回报格式不一致', path: ['formatVersion'] },
)
export type StoryProgress = z.infer<typeof storyProgressSchema>
export const storyNoticeInputSchema = z.object({ id: uuid, situation: text }).strict()
export const storyNoticeDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('continue'), reason: text }).strict(),
  z.object({ action: z.literal('adjust'), reason: text, direction: text }).strict(),
  z.object({ action: z.literal('terminate'), reason: text }).strict(),
])
const noticeIdentity = { formatVersion: z.literal(1), runId: uuid, storyId: uuid, parentStoryId: uuid, noticeId: uuid }
export const storyNoticeSchema = z.discriminatedUnion('kind', [
  z.object({ ...noticeIdentity, kind: z.literal('report'), value: reportSchema }).strict(),
  z.object({ ...noticeIdentity, kind: z.literal('decision'), value: storyNoticeDecisionSchema }).strict(),
])
export type StoryNoticeInput = z.infer<typeof storyNoticeInputSchema>
export type StoryNoticeDecision = z.infer<typeof storyNoticeDecisionSchema>
export type StoryNotice = z.infer<typeof storyNoticeSchema>
export const storyChoiceSchema = z.object({ formatVersion: z.literal(1), runId: uuid, parentStoryId: uuid, childStoryId: uuid, description: text, decision: z.enum(['continue', 'adjust', 'cancel']), reason: text }).strict()
export type StoryChoice = z.infer<typeof storyChoiceSchema>

/** 为已有规划内的一个事件生成独立的父故事与协作身份。 */
export function collaborationIdentity(plan: PlanRecord, childStoryId: string) {
  const valid = planRecordSchema.parse(plan)
  uuid.parse(childStoryId)
  if (valid.outcome.kind !== 'planned' || !valid.outcome.events.some(event => event.id === childStoryId)) throw new Error('事件不属于所选规划')
  return { id: randomUUID(), parentStoryId: randomUUID(), childStoryId }
}
