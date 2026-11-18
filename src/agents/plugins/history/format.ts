import { parseDocument } from 'yaml'
import { z } from 'zod'

const text = z.string().trim().min(1)
export const historyIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const basis = z.discriminatedUnion('kind', [z.object({ kind: z.literal('initialization') }).strict(), z.object({ kind: z.literal('era'), id: text }).strict()])
const timeExpression = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), original: text }).strict(),
  z.object({ kind: z.literal('point'), original: text, basis, unit: text, value: z.number().finite(), precision: z.enum(['exact', 'approximate']) }).strict(),
  z.object({ kind: z.literal('interval'), original: text, basis, unit: text, start: z.number().finite().nullable(), end: z.number().finite().nullable(), precision: z.enum(['exact', 'approximate']) }).strict().superRefine((item, ctx) => {
    if (item.start === null && item.end === null) ctx.addIssue({ code: 'custom', message: '时间区间至少需要一个已知端点' })
    if (item.start !== null && item.end !== null && item.start > item.end) ctx.addIssue({ code: 'custom', message: '时间区间起点不能晚于终点' })
  }),
])
const reference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('linked'), type: z.enum(['person', 'place', 'organization']), id: historyIdSchema, description: z.string() }).strict(),
  z.object({ kind: z.literal('unresolved'), type: z.enum(['person', 'place', 'organization']), description: text }).strict(),
])
const parent = z.object({ id: historyIdSchema, description: text }).strict()
const relation = z.object({ kind: z.enum(['before', 'causes', 'overlaps', 'related']), targetId: historyIdSchema, description: z.string() }).strict()
const account = z.object({ content: text, source: z.string() }).strict()
const hidden = z.discriminatedUnion('state', [z.object({ state: z.literal('unknown'), note: z.string() }).strict(),
  z.object({ state: z.literal('known'), content: text }).strict()])

/** 世界初始化历史事件版本 1；事件和角色认知分开保存。 */
export const historyEventSchema = z.object({
  formatVersion: z.literal(1), worldId: text, id: historyIdSchema, name: text, aliases: z.array(text),
  detailLevel: z.enum(['unexpanded', 'overview', 'detailed']), contentStatus: z.enum(['suggested', 'confirmed']),
  summary: z.string(), body: z.string(), time: z.array(timeExpression), parents: z.array(parent),
  childrenCoverage: z.enum(['unknown', 'partial', 'complete']), relations: z.array(relation), references: z.array(reference),
  publicAccounts: z.array(account), hidden, reserved: z.array(text),
}).strict().superRefine((event, ctx) => {
  const parentIds = event.parents.map(item => item.id)
  if (parentIds.includes(event.id)) ctx.addIssue({ code: 'custom', message: '事件不能是自身上级' })
  if (new Set(parentIds).size !== parentIds.length) ctx.addIssue({ code: 'custom', message: '事件上级重复' })
  if (event.relations.some(item => item.targetId === event.id)) ctx.addIssue({ code: 'custom', message: '事件不能关联自身' })
  const relationKeys = event.relations.map(item => JSON.stringify([item.kind, item.targetId]))
  if (new Set(relationKeys).size !== relationKeys.length) ctx.addIssue({ code: 'custom', message: '事件关系重复' })
})
export type HistoryEvent = z.infer<typeof historyEventSchema>

/** 解析历史 JSON；拒绝无效 JSON、重复键、未知版本及额外字段。 */
export function parseHistoryEvent(value: string): HistoryEvent {
  const json: unknown = JSON.parse(value)
  if (parseDocument(value, { uniqueKeys: true }).errors.length) throw new Error('历史 JSON 含重复键或无效结构')
  return historyEventSchema.parse(json)
}

/** 校验并序列化版本 1 事件。 */
export function formatHistoryEvent(value: HistoryEvent): string { return `${JSON.stringify(historyEventSchema.parse(value), null, 2)}\n` }

/** 校验同一世界内完整事件集合的身份、上级引用与无环关系；不推断因果或时间。 */
export function validateHistoryEventGraph(values: readonly HistoryEvent[], worldId: string): void {
  const events = values.map(value => historyEventSchema.parse(value)); const byId = new Map<string, HistoryEvent>()
  for (const event of events) {
    if (event.worldId !== worldId) throw new Error('历史事件世界不匹配')
    if (byId.has(event.id)) throw new Error('历史事件 ID 重复')
    byId.set(event.id, event)
  }
  for (const event of events) {
    for (const item of event.parents) if (!byId.has(item.id)) throw new Error('历史事件上级不存在')
    for (const item of event.relations) if (!byId.has(item.targetId)) throw new Error('历史关联事件不存在')
  }
  const states = new Map<string, 'visiting' | 'done'>()
  for (const event of events) {
    if (states.get(event.id) === 'done') continue
    const stack: { id: string; next: number }[] = [{ id: event.id, next: 0 }]
    states.set(event.id, 'visiting')
    while (stack.length) {
      const frame = stack[stack.length - 1]!
      const parents = byId.get(frame.id)!.parents
      if (frame.next === parents.length) { states.set(frame.id, 'done'); stack.pop(); continue }
      const id = parents[frame.next++]!.id; const state = states.get(id)
      if (state === 'visiting') throw new Error('历史事件上级关系存在循环')
      if (!state) { states.set(id, 'visiting'); stack.push({ id, next: 0 }) }
    }
  }
}
