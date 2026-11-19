import { defineTool, type ParameterSchemaSpec, type ToolAgentIdentity, type ToolDefinition, type ToolRunContext } from '@fly-novel/tools'
import { z } from 'zod'
import { contentSchema, idSchema, kindSchema } from './format.js'
import { DevelopmentError, type DevelopmentStore } from './store.js'
import { DevelopmentQueries, searchSchema } from './query.js'

const required = { type: 'string', required: true } as const
const content = { type: 'json', required: true, description: '完整内容示例：{"name":"水源规划","summary":"概况","body":"按需正文","reserved":[],"applicability":{"kind":"unknown"},"references":[],"links":[],"person":null}。kind 为 growth-line 时 person 必须是 {"kind":"linked","id":"人物UUID"} 或 {"kind":"unresolved","description":"线索"}，其他类型 person 为 null。适用性可用 {"kind":"general","description":"通用原因"} 或 {"kind":"scoped","scopes":[{"overviewId":"方案UUID","description":"该方案的条件","situationIds":[]}]}。关联项 {"targetKind":"storyline","targetId":"UUID","relation":"相关","description":"说明"}。引用项 {"kind":"unresolved","type":"place","description":"线索"} 或 {"kind":"linked","type":"person","id":"UUID","description":"说明","observedVersion":null}。' } as const
const kinds = 'macro-blueprint、direction、proposal、storyline、growth-line、growth-blueprint、growth-item'
const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const identity = z.object({ kind: kindSchema, id: idSchema }).strict()
const creation = z.object({ kind: kindSchema, content: contentSchema }).strict()
const change = z.object({ kind: kindSchema, id: idSchema, version: z.string().min(1), content: contentSchema }).strict()

/** 完整规划工具仅供可信规划者使用；身份由应用绑定。 */
export function createDevelopmentTools(store: DevelopmentStore, identityValue: ToolAgentIdentity, access: 'read-only' | 'read-write'): ToolDefinition[] {
  if (!identityValue || !['read-only', 'read-write'].includes(access) || (access === 'read-write' && !store.writable)) throw new DevelopmentError('规划工具身份或权限无效', 'DEVELOPMENT_FORBIDDEN')
  const query = new DevelopmentQueries(store)
  const tool = (name: string, description: string, parameters: ParameterSchemaSpec, run: (args: unknown, ctx: ToolRunContext) => Promise<unknown>, mutation = false) => defineTool({ name, description, parameters, output, ...(mutation ? { reportOnAbort: true } : {}), async execute(args, ctx) {
    if (ctx.agent !== identityValue) throw new DevelopmentError('规划工具身份不匹配', 'DEVELOPMENT_FORBIDDEN')
    try { return z.json().parse(await run(args, ctx)) } catch (error) { if (error instanceof DevelopmentError && error.code === 'DEVELOPMENT_COMMIT_UNKNOWN' && error.path) return { status: 'unknown', path: error.path }; throw error }
  } })
  const tools = [
    tool('world_development_read', `按类型与 ID 读取规划文件及版本。类型：${kinds}。`, { kind: required, id: required }, (args, ctx) => { const q = identity.parse(args); return store.readDocument(q.kind, q.id, ctx.signal) }),
    tool('world_development_search', `查询已记录规划；可按类型、人物、局势方案、名称筛选。类型：${kinds}。`, { kind: { type: 'string' }, keyword: { type: 'string' }, personId: { type: 'string' }, overviewId: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' }, version: { type: 'string' } }, (args, ctx) => query.search(searchSchema.parse(args), ctx.signal)),
    tool('world_development_related_read', '查询已记录关联及原始方向，不推断因果。', { kind: required, id: required }, (args, ctx) => { const q = identity.parse(args); return query.related(q.kind, q.id, ctx.signal) }),
    tool('world_development_candidate_read', '读取已确认规划的待审候选及基线状态。', { kind: required, id: required }, (args, ctx) => { const q = identity.parse(args); return store.readCandidate(q.kind, q.id, ctx.signal) }),
    tool('world_development_reference_check', '核验外部引用身份及来源版本；错误不等于不存在。', { type: required, id: required, observedVersion: { type: 'string' } }, (args, ctx) => { const q = z.object({ type: z.enum(['history', 'place', 'organization', 'organization-relation', 'person', 'person-relation']), id: idSchema, observedVersion: z.string().min(1).optional() }).strict().parse(args); return store.checkReference(q.type, q.id, q.observedVersion ?? null, ctx.signal) }),
    tool('world_development_situation_check', '核验局势方案及可选条目的真实归属。', { overviewId: required, situationId: { type: 'string' } }, (args, ctx) => { const q = z.object({ overviewId: idSchema, situationId: idSchema.optional() }).strict().parse(args); return store.checkSituation(q.overviewId, q.situationId ?? null, ctx.signal) }),
    tool('world_development_consistency_check', '核验已记录规划身份及关系，报告未检查范围。', {}, (_, ctx) => query.consistency(ctx.signal)),
  ]
  if (access === 'read-write') tools.push(
    tool('world_development_create', `创建待审规划；类型：${kinds}。每人至多一条成长线。`, { kind: required, content }, (args, ctx) => { const q = creation.parse(args); return store.create(q.kind, q.content, ctx.signal) }, true),
    tool('world_development_update', '按读取版本完整更新未确认规划；绑定人物需重新核验唯一性。', { kind: required, id: required, version: required, content }, (args, ctx) => { const q = change.parse(args); return store.update(q.kind, q.id, q.version, q.content, ctx.signal) }, true),
    tool('world_development_candidate_prepare', '为已确认规划准备候选，不更改当前正文。', { kind: required, id: required, version: required, content }, (args, ctx) => { const q = change.parse(args); return store.prepare(q.kind, q.id, q.version, q.content, ctx.signal) }, true),
  )
  return tools
}
