import { createHash } from 'node:crypto'
import { z } from 'zod'
import { idSchema, kindSchema } from './format.js'
import { DevelopmentError, type DevelopmentStore } from './store.js'

export const searchSchema = z.object({ kind: kindSchema.optional(), keyword: z.string().trim().min(1).optional(), personId: idSchema.optional(), overviewId: idSchema.optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20), version: z.string().min(1).optional() }).strict()
/** 查询只覆盖已记录资料，局势未判断的结果单独返回。 */
export class DevelopmentQueries {
  constructor(private readonly store: DevelopmentStore) {}
  async search(input: z.input<typeof searchSchema>, signal?: AbortSignal) {
    const q = searchSchema.parse(input)
    const checked = q.overviewId ? await this.store.checkSituation(q.overviewId, null, signal) : undefined
    if (checked && checked.status !== 'verified') throw new DevelopmentError(`局势方案无法核验：${checked.status}`, checked.status === 'not_found' ? 'DEVELOPMENT_NOT_FOUND' : 'DEVELOPMENT_REFERENCE_UNAVAILABLE')
    const snapshot = await this.store.snapshot(signal); const version = createHash('sha256').update(JSON.stringify([snapshot.version, q.kind, q.keyword, q.personId, q.overviewId, checked])).digest('hex')
    if ((q.offset > 0 && !q.version) || (q.version && q.version !== version)) throw new DevelopmentError('查询条件或规划版本已变化', 'DEVELOPMENT_CONFLICT')
    const growthIds = new Set(snapshot.items.filter(item => item.document.kind === 'growth-line' && item.document.person?.kind === 'linked' && item.document.person.id === q.personId).map(item => item.document.id))
    const candidates = snapshot.items.map(item => item.document).filter(item => (!q.kind || item.kind === q.kind) && (!q.keyword || [item.name, item.summary, item.body].some(value => value.includes(q.keyword!))) && (!q.personId || (item.person?.kind === 'linked' && item.person.id === q.personId) || item.references.some(ref => ref.kind === 'linked' && ref.type === 'person' && ref.id === q.personId) || item.links.some(link => link.targetKind === 'growth-line' && growthIds.has(link.targetId))))
    const relevant = candidates.filter(item => !q.overviewId || item.applicability.kind === 'general' || (item.applicability.kind === 'scoped' && item.applicability.scopes.some(scope => scope.overviewId === q.overviewId)))
    const unknown = q.overviewId ? candidates.filter(item => item.applicability.kind === 'unknown').map(item => ({ id: item.id, kind: item.kind, name: item.name })) : []
    const items = []
    for (const item of relevant.slice(q.offset, q.offset + q.limit)) {
      const scope = item.applicability.kind === 'scoped' ? item.applicability.scopes.find(value => value.overviewId === q.overviewId) : undefined
      const recorded = scope?.observedVersion; const actual = checked?.status === 'verified' ? checked.version : null
      const situationChecks = scope ? await Promise.all(scope.situationIds.map(async id => ({ id, ...(await this.store.checkSituation(scope.overviewId, id, signal)) }))) : []
      items.push({ ...item, ...(scope ? { sourceVersionStatus: !recorded || !actual ? 'unknown' as const : recorded === actual ? 'current' as const : 'changed' as const, situationChecks } : {}) })
    }
    return { items, total: relevant.length, nextOffset: q.offset + q.limit < relevant.length ? q.offset + q.limit : null, unknown, version, scope: 'recorded' as const }
  }
  async related(kind: z.infer<typeof kindSchema>, id: string, signal?: AbortSignal) {
    kindSchema.parse(kind); idSchema.parse(id); const snapshot = await this.store.snapshot(signal)
    if (!snapshot.items.some(item => item.document.id === id && item.document.kind === kind)) throw new DevelopmentError('规划不存在', 'DEVELOPMENT_NOT_FOUND')
    const items = snapshot.items.flatMap(({ document }) => document.links.map(link => ({ fromKind: document.kind, fromId: document.id, ...link }))).filter(link => (link.fromKind === kind && link.fromId === id) || (link.targetKind === kind && link.targetId === id))
    return { items, scope: 'recorded' as const, unchecked: ['未记录关联和语义因果'] }
  }
  async consistency(signal?: AbortSignal) {
    const snapshot = await this.store.snapshot(signal)
    return { checked: snapshot.items.length, scope: 'recorded' as const, findings: [], unchecked: ['外部引用现状、语义冲突、未来实际发生情况和角色认知'] }
  }
}
