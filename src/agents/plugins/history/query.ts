import { createHash } from 'node:crypto'
import { z } from 'zod'
import { historyIdSchema, type HistoryEvent } from './format.js'
import { HistoryError, type HistorySnapshot, type HistoryStore } from './store.js'

const page = { offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20), version: z.string().min(1).optional() }
const basis = z.discriminatedUnion('kind', [z.object({ kind: z.literal('initialization') }).strict(), z.object({ kind: z.literal('era'), id: z.string().trim().min(1) }).strict()])
const range = z.object({ basis, unit: z.string().trim().min(1), start: z.number().finite(), end: z.number().finite() }).strict().refine(value => value.start <= value.end, '时间范围无效')
export const historySearchSchema = z.object({ keyword: z.string().trim().min(1).optional(), detailLevel: z.enum(['unexpanded', 'overview', 'detailed']).optional(),
  reference: z.object({ type: z.enum(['person', 'place', 'organization']), id: historyIdSchema }).strict().optional(), timeRange: range.optional(), ...page }).strict()
export const historyTreeSchema = z.object({ id: historyIdSchema, depth: z.number().int().min(1).max(32).default(1), ...page }).strict()
export const historyRelationsSchema = z.object({ id: historyIdSchema, direction: z.enum(['in', 'out', 'any']).default('any'), kind: z.enum(['before', 'causes', 'overlaps', 'related']).optional(), ...page }).strict()
export const historyTimelineSchema = z.object({ ...page }).strict()

function paginate<T>(scope: string, snapshot: HistorySnapshot, items: T[], query: { offset: number; limit: number; version?: string }) {
  const { offset, limit, version, ...filter } = query
  const current = createHash('sha256').update(JSON.stringify([scope, snapshot.version, filter])).digest('hex')
  if (offset > 0 && !version) throw new HistoryError('后续页需要查询版本', 'HISTORY_CONFLICT')
  if (version && version !== current) throw new HistoryError('历史资料或查询条件已变化', 'HISTORY_CONFLICT')
  return { items: items.slice(offset, offset + limit), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null, version: current }
}
function find(s: HistorySnapshot, id: string): HistoryEvent {
  const value = s.events.find(item => item.document.id === id)?.document
  if (!value) throw new HistoryError('历史事件不存在', 'HISTORY_NOT_FOUND')
  return value
}
type TimeRange = z.infer<typeof range>
function timeMatch(event: HistoryEvent, query: TimeRange): 'match' | 'outside' | 'unknown' {
  const values = event.time.filter(value => value.kind === 'point' && value.precision === 'exact' && JSON.stringify(value.basis) === JSON.stringify(query.basis) && value.unit === query.unit)
  if (values.length !== 1 || values[0].kind !== 'point' || event.time.length !== 1) return 'unknown'
  return values[0].value >= query.start && values[0].value <= query.end ? 'match' : 'outside'
}

/** 历史查询每次扫描权威文档；时间未知不会被当成范围外。 */
export class HistoryQueries {
  constructor(private readonly store: HistoryStore) {}
  async search(input: z.input<typeof historySearchSchema>, signal?: AbortSignal) {
    const q = historySearchSchema.parse(input); const snapshot = await this.store.snapshot(signal)
    const candidates = snapshot.events.map(value => value.document).filter(event => (!q.keyword || [event.name, ...event.aliases, event.summary, event.body].some(value => value.includes(q.keyword!))) &&
      (!q.detailLevel || event.detailLevel === q.detailLevel))
    const referenceUncertain = Boolean(q.reference && candidates.some(event => event.references.some(ref => ref.kind === 'unresolved' && ref.type === q.reference!.type)))
    const items = candidates.filter(event => !q.reference || event.references.some(ref => ref.kind === 'linked' && ref.type === q.reference!.type && ref.id === q.reference!.id))
      .map(event => ({ id: event.id, name: event.name, detailLevel: event.detailLevel, contentStatus: event.contentStatus,
        time: event.time, ...(q.timeRange ? { timeMatch: timeMatch(event, q.timeRange) } : {}) }))
      .filter(value => value.timeMatch !== 'outside')
    return { ...paginate('search', snapshot, items, q), scope: 'recorded', complete: !referenceUncertain, ...(q.reference ? { referenceUncertain } : {}), ...(q.timeRange ? { timeUncertain: items.some(item => item.timeMatch === 'unknown') } : {}) }
  }
  private async tree(input: z.input<typeof historyTreeSchema>, direction: 'children' | 'ancestors', signal?: AbortSignal) {
    const q = historyTreeSchema.parse(input); const snapshot = await this.store.snapshot(signal); find(snapshot, q.id)
    let frontier = [{ id: q.id, path: [q.id] }]; const found = new Map<string, { event: HistoryEvent; paths: string[][] }>(); let count = 0; let incomplete = false
    for (let depth = 0; depth < q.depth && frontier.length; depth++) {
      const next: typeof frontier = []
      for (const node of frontier) {
        signal?.throwIfAborted(); const current = find(snapshot, node.id)
        if (direction === 'children' && current.childrenCoverage !== 'complete') incomplete = true
        const ids = direction === 'children' ? snapshot.events.filter(value => value.document.parents.some(parent => parent.id === node.id)).map(value => value.document.id) : current.parents.map(parent => parent.id)
        for (const id of ids) {
          if (++count > 10000) throw new HistoryError('历史路径数量超过限制', 'HISTORY_LIMIT')
          const event = find(snapshot, id); const path = [...node.path, id]; const old = found.get(id)
          if (old) old.paths.push(path); else found.set(id, { event, paths: [path] })
          next.push({ id, path })
        }
      }
      frontier = next
    }
    const truncated = frontier.some(node => direction === 'children' ? snapshot.events.some(value => value.document.parents.some(parent => parent.id === node.id)) : find(snapshot, node.id).parents.length > 0)
    if (direction === 'children' && frontier.some(node => find(snapshot, node.id).childrenCoverage !== 'complete')) incomplete = true
    const items = [...found.values()].map(({ event, paths }) => ({ id: event.id, name: event.name, parents: event.parents, childrenCoverage: event.childrenCoverage, paths }))
    return { ...paginate(direction, snapshot, items, q), scope: 'recorded', complete: !truncated && !incomplete, truncated, ...(incomplete ? { reason: '子事件覆盖范围未完整记录' } : {}) }
  }
  children(input: z.input<typeof historyTreeSchema>, signal?: AbortSignal) { return this.tree(input, 'children', signal) }
  ancestors(input: z.input<typeof historyTreeSchema>, signal?: AbortSignal) { return this.tree(input, 'ancestors', signal) }
  async relations(input: z.input<typeof historyRelationsSchema>, signal?: AbortSignal) {
    const q = historyRelationsSchema.parse(input); const snapshot = await this.store.snapshot(signal); find(snapshot, q.id)
    const items = snapshot.events.flatMap(({ document }) => document.relations.map(value => ({ fromId: document.id, ...value })))
      .filter(value => (!q.kind || value.kind === q.kind) && ((q.direction !== 'in' && value.fromId === q.id) || (q.direction !== 'out' && value.targetId === q.id)))
    return { ...paginate('relations', snapshot, items, q), scope: 'recorded', complete: true }
  }
  async timeline(input: z.input<typeof historyTimelineSchema>, signal?: AbortSignal) {
    const q = historyTimelineSchema.parse(input); const snapshot = await this.store.snapshot(signal)
    const groups = new Map<string, { basis: z.infer<typeof basis>; unit: string; events: { id: string; name: string; value: number }[] }>(); const unknown: { id: string; name: string; time: HistoryEvent['time'] }[] = []
    for (const { document } of snapshot.events) {
      signal?.throwIfAborted()
      if (document.time.length !== 1 || document.time[0].kind !== 'point' || document.time[0].precision !== 'exact') { unknown.push({ id: document.id, name: document.name, time: document.time }); continue }
      const time = document.time[0]; const key = JSON.stringify([time.basis, time.unit]); const group = groups.get(key) ?? { basis: time.basis, unit: time.unit, events: [] }
      group.events.push({ id: document.id, name: document.name, value: time.value }); groups.set(key, group)
    }
    const items = [...groups.values()].sort((a, b) => JSON.stringify([a.basis, a.unit]).localeCompare(JSON.stringify([b.basis, b.unit])))
      .flatMap(group => group.events.sort((a, b) => a.value - b.value || a.id.localeCompare(b.id)).map(event => ({ ...event, basis: group.basis, unit: group.unit })))
    return { ...paginate('timeline', snapshot, items, q), scope: 'recorded', unknown, relations: snapshot.events.flatMap(({ document }) => document.relations.filter(value => value.kind === 'before' || value.kind === 'overlaps').map(value => ({ fromId: document.id, ...value }))),
      complete: unknown.length === 0 && groups.size <= 1, note: '仅同一基准和单位的精确点可比较；不同组之间不表示先后。' }
  }
  async consistency(signal?: AbortSignal) {
    const snapshot = await this.store.snapshot(signal)
    return { status: 'checked', checked: ['事件格式', '同世界事件身份', '已记录上级与事件引用', '上级关系无环'], eventCount: snapshot.events.length,
      notChecked: ['时间与因果语义冲突', '人物组织地点实际存在与变化', '未登记资料', '角色认知'] }
  }
}
