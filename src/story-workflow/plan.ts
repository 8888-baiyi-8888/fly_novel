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
