import { defineTool, type ParameterSchemaSpec, type ToolAgentIdentity, type ToolDefinition, type ToolRunContext } from '@fly-novel/tools'
import { z } from 'zod'
import { historyEventSchema, historyIdSchema } from './format.js'
import { HistoryError, type HistoryStore } from './store.js'
import { HistoryQueries, historyRelationsSchema, historySearchSchema, historyTimelineSchema, historyTreeSchema } from './query.js'

const { name, aliases, detailLevel, summary, body, time, parents, childrenCoverage, relations, references, publicAccounts, hidden, reserved } = historyEventSchema.shape
const content = z.object({ name, aliases, detailLevel, summary, body, time, parents, childrenCoverage, relations, references, publicAccounts, hidden, reserved }).strict()
const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const str = { type: 'string' } as const; const required = { type: 'string', required: true } as const
const paging = { offset: { type: 'integer' }, limit: { type: 'integer' }, version: str } as const
const data = { type: 'json', required: true, description: '完整事件对象示例：{"name":"战争","aliases":[],"detailLevel":"overview","summary":"概况","body":"经过","time":[],"parents":[],"childrenCoverage":"unknown","relations":[],"references":[],"publicAccounts":[],"hidden":{"state":"unknown","note":""},"reserved":[]}。detailLevel 为 unexpanded、overview、detailed；childrenCoverage 为 unknown、partial、complete。上级项为 {id,description}；关联项为 {kind,targetId,description}，kind 为 before、causes、overlaps、related；引用项为 {kind:"linked",type:"person",id,description} 或 {kind:"unresolved",type:"person",description}，type 可为 person、place、organization；公开说法项为 {content,source}。时间项可用 {kind:"text",original} 或 {kind:"point",original,basis:{kind:"initialization"},unit:"year",value:-300,precision:"approximate"}；其他字段无内容时使用示例中的空值。隐藏内容已知时用 {state:"known",content:"正文"}。不要提供世界、事件 ID、格式版本或确认状态。' } as const
const input = z.object({ content }).strict(); const id = z.object({ id: historyIdSchema }).strict()
const update = z.object({ id: historyIdSchema, version: z.string().min(1), content }).strict()
const ref = z.object({ type: z.enum(['person', 'place', 'organization']), id: historyIdSchema }).strict()

/** 由可信应用绑定身份和访问方式；历史规划工具包含隐藏内容，不能作为角色认知视图。 */
export function createHistoryTools(store: HistoryStore, identity: ToolAgentIdentity, access: 'read-only' | 'read-write'): ToolDefinition[] {
  if (!identity || (access !== 'read-only' && access !== 'read-write')) throw new HistoryError('历史工具身份或权限无效', 'HISTORY_INVALID_CONFIG')
  if (access === 'read-write' && !store.writable) throw new HistoryError('只读存储不能装配写工具', 'HISTORY_FORBIDDEN')
  const query = new HistoryQueries(store)
  const tool = (name: string, description: string, parameters: ParameterSchemaSpec, run: (args: unknown, ctx: ToolRunContext) => Promise<unknown>, mutation = false) =>
    defineTool({ name, description, parameters, output, ...(mutation ? { reportOnAbort: true } : {}), async execute(args, ctx) {
      if (ctx.agent !== identity) throw new HistoryError('历史工具身份不匹配', 'HISTORY_FORBIDDEN')
      try { return z.json().parse(await run(args, ctx)) }
      catch (error) { if (error instanceof HistoryError && error.code === 'HISTORY_COMMIT_UNKNOWN' && error.path) return { status: 'unknown', path: error.path }; throw error }
    } })
  const tools = [
    tool('history_event_read', '按 ID 读取完整事件及版本，含公开和隐藏内容。', { id: required }, (args, ctx) => store.readEvent(id.parse(args).id, ctx.signal)),
    tool('history_candidate_read', '读取已确认历史的候选及基线是否过期。', { id: required }, (args, ctx) => store.readCandidate(id.parse(args).id, ctx.signal)),
    tool('history_event_search', '按关键词、展开程度、引用或时间范围检索；无法比较的时间保留为 unknown。', { keyword: str, detailLevel: str,
      reference: { type: 'json' }, timeRange: { type: 'json', description: '{basis:{kind:"initialization"}或{kind:"era",id},unit,start,end}' }, ...paging }, (args, ctx) => query.search(historySearchSchema.parse(args), ctx.signal)),
    tool('history_event_children', '按已记录的上级关联查询子事件；返回所有上级、路径和未展开说明。', { id: required, depth: { type: 'integer' }, ...paging }, (args, ctx) => query.children(historyTreeSchema.parse(args), ctx.signal)),
    tool('history_event_ancestors', '查询事件的所有已记录上级路径。', { id: required, depth: { type: 'integer' }, ...paging }, (args, ctx) => query.ancestors(historyTreeSchema.parse(args), ctx.signal)),
    tool('history_event_relations', '查询事件已记录的先后、因果或其他关系；反查不表示反向因果。', { id: required, direction: str, kind: str, ...paging }, (args, ctx) => query.relations(historyRelationsSchema.parse(args), ctx.signal)),
    tool('history_timeline', '按相同参考基准和单位排列精确时间；未知、近似和不一致表达单独报告。', { ...paging }, (args, ctx) => query.timeline(historyTimelineSchema.parse(args), ctx.signal)),
    tool('history_reference_check', '通过可信解析器核验同世界人物、地点或组织引用。', { type: { type: 'string', enum: ['person', 'place', 'organization'], required: true }, id: required }, (args, ctx) => { const q = ref.parse(args); return store.checkReference(q.type, q.id, ctx.signal) }),
    tool('history_consistency_check', '检查事件格式、上级及事件引用，报告未覆盖的语义与跨模块检查。', {}, (_, ctx) => query.consistency(ctx.signal)),
  ]
  if (access === 'read-write') tools.push(
    tool('history_event_create', '创建待审历史事件，程序生成 ID；关联目标必须已存在。', { content: data }, (args, ctx) => store.create(input.parse(args).content, ctx.signal), true),
    tool('history_event_update', '按版本完整更新未确认历史；已有候选或确认状态会拒绝。', { id: required, version: required, content: data }, (args, ctx) => { const q = update.parse(args); return store.update(q.id, q.version, q.content, ctx.signal) }, true),
    tool('history_candidate_prepare', '为已确认历史保存待审候选，不修改当前正文或提交确认。', { id: required, version: required, content: data }, (args, ctx) => { const q = update.parse(args); return store.prepare(q.id, q.version, q.content, ctx.signal) }, true),
  )
  return tools
}
