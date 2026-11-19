import { defineTool, type ParameterSchemaSpec, type ToolAgentIdentity, type ToolDefinition, type ToolRunContext } from '@fly-novel/tools'
import { z } from 'zod'
import { overviewSchema, situationIdSchema, situationSchema } from './format.js'
import { SituationError, type SituationStore } from './store.js'
import { SituationQueries, situationSearchSchema } from './query.js'

const overview = overviewSchema.omit({ formatVersion: true, worldId: true, id: true, contentStatus: true })
const { overviewId, name, aliases, detailLevel, summary, body, references, relations, reserved } = situationSchema.shape
const situation = z.object({ overviewId, name, aliases, detailLevel, summary, body, references, relations, reserved }).strict()
const required = { type: 'string', required: true } as const
const content = { type: 'json', required: true, description: '方案内容示例：{"name":"河谷","summary":"概况","coverage":"河谷","reserved":[]}。局势内容示例：{"overviewId":"方案UUID","name":"供水紧张","aliases":[],"detailLevel":"overview","summary":"概况","body":"正文","references":[],"relations":[],"reserved":[]}；关联为 {targetId,description}；未关联引用为 {kind:"unresolved",type:"place",description:"线索"}，已关联引用为 {kind:"linked",type:"place",id:"UUID",description:"说明",observedVersion:null}。引用类型包含 history、place、organization、organization-relation、person、person-relation；world-basics 只能作为未关联线索。' } as const
const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const id = z.object({ id: situationIdSchema }).strict()
const kind = z.enum(['overview', 'situation'])
const change = z.object({ kind, id: situationIdSchema, version: z.string().min(1), content: z.unknown() }).strict()

/** 工具身份由可信应用绑定；完整局势不作为故事角色的认知视图。 */
export function createSituationTools(store: SituationStore, identity: ToolAgentIdentity, access: 'read-only' | 'read-write'): ToolDefinition[] {
  if (!identity || !['read-only', 'read-write'].includes(access) || (access === 'read-write' && !store.writable)) throw new SituationError('局势工具身份或权限无效', 'SITUATION_FORBIDDEN')
  const query = new SituationQueries(store)
  const tool = (name: string, description: string, parameters: ParameterSchemaSpec, run: (args: unknown, ctx: ToolRunContext) => Promise<unknown>, mutation = false) => defineTool({ name, description, parameters, output, ...(mutation ? { reportOnAbort: true } : {}), async execute(args, ctx) {
    if (ctx.agent !== identity) throw new SituationError('局势工具身份不匹配', 'SITUATION_FORBIDDEN')
    try { return z.json().parse(await run(args, ctx)) } catch (error) { if (error instanceof SituationError && error.code === 'SITUATION_COMMIT_UNKNOWN' && error.path) return { status: 'unknown', path: error.path }; throw error }
  } })
  const tools = [
    tool('situation_start_read', '读取该世界唯一的初始化起点说明和文件版本。', {}, (_, ctx) => store.readStart(ctx.signal)),
    tool('situation_overview_read', '按 ID 读取一个局势方案总览。', { id: required }, (args, ctx) => store.readOverview(id.parse(args).id, ctx.signal)),
    tool('situation_overview_list', '列出当前世界已记录的局势方案。', {}, async (_, ctx) => ({ items: (await store.snapshot(ctx.signal)).overviews, scope: 'recorded' })),
    tool('situation_read', '按 ID 读取局势条目及其所属方案。', { id: required }, (args, ctx) => store.readSituation(id.parse(args).id, ctx.signal)),
    tool('situation_candidate_read', '读取指定类型的待审候选及基线是否过期。', { kind: required, id: required }, (args, ctx) => { const q = z.object({ kind, id: situationIdSchema }).strict().parse(args); return store.readCandidate(q.kind, q.id, ctx.signal) }),
    tool('situation_search', '查询一个方案已记录的局势；后续分页必须使用查询版本。', { overviewId: required, keyword: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' }, version: { type: 'string' } }, (args, ctx) => query.search(situationSearchSchema.parse(args), ctx.signal)),
    tool('situation_related_read', '读取已记录的局势关系及引用，不推断反向因果。', { id: required }, (args, ctx) => query.related(id.parse(args).id, ctx.signal)),
    tool('situation_consistency_check', '检查已记录条目与方案、条目间关联，报告未检查范围。', {}, (_, ctx) => query.consistency(ctx.signal)),
    tool('situation_reference_check', '核验可信绑定的外部对象及记录版本；不能核验时说明原因。', { type: required, id: required, observedVersion: { type: 'string' } }, (args, ctx) => { const q = z.object({ type: z.enum(['history', 'place', 'organization', 'organization-relation', 'person', 'person-relation']), id: situationIdSchema, observedVersion: z.string().min(1).optional() }).strict().parse(args); return store.checkReference(q.type, q.id, q.observedVersion ?? null, ctx.signal) }),
  ]
  if (access === 'read-write') tools.push(
    tool('situation_start_create', '独占创建世界起点说明。', { description: required }, (args, ctx) => store.createStart(z.object({ description: z.string().trim().min(1) }).strict().parse(args).description, ctx.signal), true),
    tool('situation_start_update', '按版本修改起点说明；先核查已有历史相对时间，不会自动换算。', { version: required, description: required }, (args, ctx) => { const q = z.object({ version: z.string().min(1), description: z.string().trim().min(1) }).strict().parse(args); return store.updateStart(q.version, q.description, ctx.signal) }, true),
    tool('situation_overview_create', '创建一个待审方案总览。', { content }, (args, ctx) => store.createOverview(z.object({ content: overview }).strict().parse(args).content, ctx.signal), true),
    tool('situation_create', '创建属于已有方案的待审局势。', { content }, (args, ctx) => store.createSituation(z.object({ content: situation }).strict().parse(args).content, ctx.signal), true),
    tool('situation_update', '按版本完整更新未确认的总览或局势。', { kind: required, id: required, version: required, content }, (args, ctx) => { const q = change.parse(args); return store.update(q.kind, q.id, q.version, q.kind === 'overview' ? overview.parse(q.content) : situation.parse(q.content), ctx.signal) }, true),
    tool('situation_candidate_prepare', '为已确认总览或局势准备候选，不修改正文。', { kind: required, id: required, version: required, content }, (args, ctx) => { const q = change.parse(args); return store.prepare(q.kind, q.id, q.version, q.kind === 'overview' ? overview.parse(q.content) : situation.parse(q.content), ctx.signal) }, true),
  )
  return tools
}
