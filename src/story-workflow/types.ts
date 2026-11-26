import { randomUUID } from 'node:crypto'
import { parseDocument } from 'yaml'
import { z } from 'zod'

const text = z.string().trim().min(1)
const uuid = z.string().uuid()
export const planInputSchema = z.object({ task: text, facts: z.array(text), directions: z.array(text) }).strict()
const proposal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('planned'), events: z.array(text).min(1) }).strict(),
  z.object({ kind: z.literal('no_events'), reason: text }).strict(),
])
const outcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('planned'), events: z.array(z.object({ id: uuid, description: text }).strict()).min(1) }).strict(),
  z.object({ kind: z.literal('no_events'), reason: text }).strict(),
])
export const planRecordSchema = z.object({ formatVersion: z.literal(1), id: uuid, input: planInputSchema, outcome }).strict().superRefine((value, ctx) => {
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
export function createPlanRecord(input: PlanInput, response: string): PlanRecord {
  const validated = planInputSchema.parse(input)
  const result = proposal.parse(parseStrictJson(response))
  return planRecordSchema.parse({ formatVersion: 1, id: randomUUID(), input: validated,
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

export const storyDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), preparation: text }).strict(),
  z.object({ kind: z.literal('split'), children: z.array(text).min(1) }).strict(),
])
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
export const storyStepSchema = z.discriminatedUnion('kind', [
  z.object({ formatVersion: z.literal(1), runId: uuid, storyId: uuid, kind: z.literal('decision'), value: savedStoryDecisionSchema }).strict(),
  z.object({ formatVersion: z.literal(1), runId: uuid, storyId: uuid, kind: z.literal('simulation'), value: simulationSchema }).strict(),
  z.object({ formatVersion: z.literal(1), runId: uuid, storyId: uuid, kind: z.literal('result'), value: reportSchema, receipt: text }).strict(),
  z.object({ formatVersion: z.literal(1), runId: uuid, storyId: uuid, kind: z.literal('assessment'), value: storyAssessmentSchema }).strict(),
  z.object({ formatVersion: z.literal(1), runId: uuid, storyId: uuid, kind: z.literal('supplement'),
    value: z.object({ id: uuid, description: text, reason: text }).strict() }).strict(),
])
export type StoryStep = z.infer<typeof storyStepSchema>
export const storyChoiceSchema = z.object({ formatVersion: z.literal(1), runId: uuid, parentStoryId: uuid, childStoryId: uuid, description: text, decision: z.enum(['continue', 'adjust', 'cancel']), reason: text }).strict()
export type StoryChoice = z.infer<typeof storyChoiceSchema>

/** 为已有规划内的一个事件生成独立的父故事与协作身份。 */
export function collaborationIdentity(plan: PlanRecord, childStoryId: string) {
  const valid = planRecordSchema.parse(plan)
  uuid.parse(childStoryId)
  if (valid.outcome.kind !== 'planned' || !valid.outcome.events.some(event => event.id === childStoryId)) throw new Error('事件不属于所选规划')
  return { id: randomUUID(), parentStoryId: randomUUID(), childStoryId }
}
