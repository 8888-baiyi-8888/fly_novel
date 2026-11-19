import { createHash } from 'node:crypto'
import { z } from 'zod'
import { situationIdSchema } from './format.js'
import { SituationError, type SituationStore } from './store.js'

export const situationSearchSchema = z.object({ overviewId: situationIdSchema, keyword: z.string().trim().min(1).optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20), version: z.string().min(1).optional() }).strict()
export class SituationQueries {
  constructor(private readonly store: SituationStore) {}
  async search(input: z.input<typeof situationSearchSchema>, signal?: AbortSignal) {
    const q = situationSearchSchema.parse(input); const snapshot = await this.store.snapshot(signal)
    if (!snapshot.overviews.some(item => item.document.id === q.overviewId)) throw new SituationError('局势方案不存在', 'SITUATION_NOT_FOUND')
    const version = createHash('sha256').update(JSON.stringify([snapshot, q.overviewId, q.keyword])).digest('hex')
    if ((q.offset > 0 && !q.version) || (q.version && q.version !== version)) throw new SituationError('局势资料或查询条件已变化', 'SITUATION_CONFLICT')
    const items = snapshot.situations.map(item => item.document).filter(item => item.overviewId === q.overviewId && (!q.keyword || [item.name, ...item.aliases, item.summary, item.body].some(value => value.includes(q.keyword!))))
    return { items: items.slice(q.offset, q.offset + q.limit), total: items.length, nextOffset: q.offset + q.limit < items.length ? q.offset + q.limit : null, version, scope: 'recorded' as const }
  }
  async related(id: string, signal?: AbortSignal) {
    situationIdSchema.parse(id); const snapshot = await this.store.snapshot(signal); const source = snapshot.situations.find(item => item.document.id === id)?.document
    if (!source) throw new SituationError('局势不存在', 'SITUATION_NOT_FOUND')
    const items = snapshot.situations.filter(item => item.document.overviewId === source.overviewId).flatMap(item => item.document.relations.map(relation => ({ fromId: item.document.id, ...relation }))).filter(relation => relation.fromId === id || relation.targetId === id)
    return { items, scope: 'recorded' as const, references: source.references }
  }
  async consistency(signal?: AbortSignal) {
    const snapshot = await this.store.snapshot(signal); const findings: string[] = []
    for (const { document: item } of snapshot.situations) {
      if (!snapshot.overviews.some(value => value.document.id === item.overviewId)) findings.push(`局势 ${item.id} 的方案缺失`)
      for (const relation of item.relations) if (!snapshot.situations.some(value => value.document.id === relation.targetId && value.document.overviewId === item.overviewId)) findings.push(`局势 ${item.id} 的关联目标缺失或不属同一方案`)
    }
    return { findings, scope: 'recorded' as const, unchecked: ['外部引用、来源变化、语义冲突、角色认知与未记录世界内容'] }
  }
}
