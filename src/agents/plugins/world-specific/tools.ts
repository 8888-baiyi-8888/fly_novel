import { defineTool, type ParameterSchemaSpec, type ToolAgentIdentity, type ToolDefinition, type ToolRunContext } from '@fly-novel/tools'
import { z } from 'zod'
import { specificContentSchema, specificIdSchema, specificKindSchema, specificReferenceTypeSchema } from './format.js'
import { SpecificError, type SpecificStore } from './store.js'
import { SpecificQueries, specificSearchSchema } from './query.js'

const required = { type: 'string', required: true } as const
const content = { type: 'json', required: true, description: '完整内容示例：{"name":"修炼体系","aliases":[],"detailLevel":"overview","summary":"概况","body":"规则正文","reserved":[],"topicIds":[],"links":[],"references":[]}。创建主题 topicIds 为 []；创建内容项 topicIds 必须包含一个或多个真实主题 UUID。links 项为 {"kind":"topic"或"item","id":"UUID","description":"关联说明"}；references 可用 {"kind":"unresolved","type":"world-basics","description":"未关联线索"} 或 {"kind":"linked","type":"place","id":"UUID","description":"说明","observedVersion":null}。detailLevel 可为 unexpanded、overview、detailed。' } as const
const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const identity = z.object({ kind: specificKindSchema, id: specificIdSchema }).strict()
const create = z.object({ content: specificContentSchema }).strict()
const update = z.object({ id: specificIdSchema, version: z.string().min(1), content: specificContentSchema }).strict()

/** 工具只面向可信规划者；身份和权限由应用绑定。 */
export function createSpecificTools(store: SpecificStore, identityValue: ToolAgentIdentity, access: 'read-only' | 'read-write'): ToolDefinition[] {
  if (!identityValue || !['read-only', 'read-write'].includes(access) || (access === 'read-write' && !store.writable)) throw new SpecificError('专有内容工具身份或权限无效', 'SPECIFIC_FORBIDDEN')
  const query = new SpecificQueries(store)
  const tool = (name: string, description: string, parameters: ParameterSchemaSpec, run: (args: unknown, ctx: ToolRunContext) => Promise<unknown>, mutation = false) => defineTool({ name, description, parameters, output, ...(mutation ? { reportOnAbort: true } : {}), async execute(args, ctx) {
    if (ctx.agent !== identityValue) throw new SpecificError('专有内容工具身份不匹配', 'SPECIFIC_FORBIDDEN')
    try { return z.json().parse(await run(args, ctx)) } catch (error) { if (error instanceof SpecificError && error.code === 'SPECIFIC_COMMIT_UNKNOWN' && error.path) return { status: 'unknown', path: error.path }; throw error }
  } })
  const searchParams = { keyword: { type: 'string' }, detailLevel: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' }, version: { type: 'string' } } as const
  const tools = [
    tool('world_specific_topic_read', '按 ID 读取主题正文及版本。', { id: required }, (args, ctx) => store.readDocument('topic', z.object({ id: specificIdSchema }).strict().parse(args).id, ctx.signal)),
    tool('world_specific_item_read', '按 ID 读取内容正文、全部主题归属及版本。', { id: required }, (args, ctx) => store.readDocument('item', z.object({ id: specificIdSchema }).strict().parse(args).id, ctx.signal)),
    tool('world_specific_topic_search', '查询当前世界已记录主题；同名返回多个候选。', searchParams, (args, ctx) => query.search(specificSearchSchema.parse({ ...z.object({ keyword: z.string().optional(), detailLevel: z.enum(['unexpanded', 'overview', 'detailed']).optional(), offset: z.number().optional(), limit: z.number().optional(), version: z.string().optional() }).strict().parse(args), kind: 'topic' }), ctx.signal)),
    tool('world_specific_item_search', '按主题、关键词或外部引用查询已记录内容；每项返回全部主题 ID。', { ...searchParams, topicId: { type: 'string' }, reference: { type: 'json', description: '{"type":"place","id":"UUID"}' } }, (args, ctx) => query.search(specificSearchSchema.parse({ ...z.object({ keyword: z.string().optional(), detailLevel: z.enum(['unexpanded', 'overview', 'detailed']).optional(), topicId: specificIdSchema.optional(), reference: z.object({ type: specificReferenceTypeSchema, id: specificIdSchema }).strict().optional(), offset: z.number().optional(), limit: z.number().optional(), version: z.string().optional() }).strict().parse(args), kind: 'item' }), ctx.signal)),
    tool('world_specific_related_read', '查询已记录关联与所有主题归属，不推断因果或完整覆盖。', { kind: required, id: required }, (args, ctx) => { const q = identity.parse(args); return query.related(q.kind, q.id, ctx.signal) }),
    tool('world_specific_reference_check', '核验可信绑定的外部对象及来源版本。', { type: required, id: required, observedVersion: { type: 'string' } }, (args, ctx) => { const q = z.object({ type: specificReferenceTypeSchema, id: specificIdSchema, observedVersion: z.string().min(1).optional() }).strict().parse(args); return store.checkReference(q.type, q.id, q.observedVersion ?? null, ctx.signal) }),
    tool('world_specific_consistency_check', '核验已记录内容的身份及关联，报告未检查范围。', {}, (_, ctx) => query.consistency(ctx.signal)),
    tool('world_specific_candidate_read', '读取已确认主题或内容项的待审候选和基线状态。', { kind: required, id: required }, (args, ctx) => { const q = identity.parse(args); return store.readCandidate(q.kind, q.id, ctx.signal) }),
  ]
  if (access === 'read-write') for (const kind of ['topic', 'item'] as const) {
    tools.push(tool(`world_specific_${kind}_create`, '创建待审主题或内容项；内容项需绑定真实主题。', { content }, (args, ctx) => store.create(kind, create.parse(args).content, ctx.signal), true))
    tools.push(tool(`world_specific_${kind}_update`, '按版本完整更新未确认的主题或内容项。', { id: required, version: required, content }, (args, ctx) => { const q = update.parse(args); return store.update(kind, q.id, q.version, q.content, ctx.signal) }, true))
  }
  if (access === 'read-write') tools.push(tool('world_specific_candidate_prepare', '为已确认主题或内容项准备待审候选，不覆盖原文。', { kind: required, id: required, version: required, content }, (args, ctx) => { const q = z.object({ kind: specificKindSchema, id: specificIdSchema, version: z.string().min(1), content: specificContentSchema }).strict().parse(args); return store.prepare(q.kind, q.id, q.version, q.content, ctx.signal) }, true))
  return tools
}
