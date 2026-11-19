import { createHash } from 'node:crypto'
import { z } from 'zod'
import { specificIdSchema, specificKindSchema, specificReferenceTypeSchema } from './format.js'
import { SpecificError, type SpecificStore } from './store.js'

export const specificSearchSchema = z.object({ kind: specificKindSchema, keyword: z.string().trim().min(1).optional(), topicId: specificIdSchema.optional(), detailLevel: z.enum(['unexpanded', 'overview', 'detailed']).optional(), reference: z.object({ type: specificReferenceTypeSchema, id: specificIdSchema }).strict().optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20), version: z.string().min(1).optional() }).strict()
/** 查询只覆盖已记录文件；主题查询的内容保留所有主题归属。 */
export class SpecificQueries {
  constructor(private readonly store: SpecificStore) {}
  async search(input: z.input<typeof specificSearchSchema>, signal?: AbortSignal) {
    const q = specificSearchSchema.parse(input); if (q.topicId && q.kind !== 'item') throw new SpecificError('主题筛选只适用于内容项', 'SPECIFIC_INVALID_QUERY')
    const snapshot = await this.store.snapshot(signal)
    if (q.topicId && !snapshot.items.some(item => item.document.kind === 'topic' && item.document.id === q.topicId)) throw new SpecificError('主题不存在', 'SPECIFIC_NOT_FOUND')
    const { offset, limit, version: previous, ...filter } = q; const version = createHash('sha256').update(JSON.stringify([snapshot.version, filter])).digest('hex')
    if ((offset > 0 && !previous) || (previous && previous !== version)) throw new SpecificError('内容或查询条件已变化', 'SPECIFIC_CONFLICT')
    const candidates = snapshot.items.map(value => value.document).filter(item => item.kind === q.kind && (!q.topicId || item.topicIds.includes(q.topicId)) && (!q.detailLevel || item.detailLevel === q.detailLevel) && (!q.keyword || [item.name, ...item.aliases, item.summary, item.body].some(value => value.includes(q.keyword!))))
    const uncertain = Boolean(q.reference && candidates.some(item => item.references.some(ref => ref.kind === 'unresolved' && ref.type === q.reference!.type)))
    const items = candidates.filter(item => !q.reference || item.references.some(ref => ref.kind === 'linked' && ref.type === q.reference!.type && ref.id === q.reference!.id))
    return { items: items.slice(offset, offset + limit), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null, version, scope: 'recorded' as const, coverage: 'unknown' as const, referenceUncertain: uncertain }
  }
  async related(kind: z.infer<typeof specificKindSchema>, id: string, signal?: AbortSignal) {
    specificKindSchema.parse(kind); specificIdSchema.parse(id); const snapshot = await this.store.snapshot(signal); const found = snapshot.items.find(item => item.document.kind === kind && item.document.id === id)?.document
    if (!found) throw new SpecificError('专有内容不存在', 'SPECIFIC_NOT_FOUND')
    const links = snapshot.items.flatMap(({ document }) => document.links.map(link => ({ fromKind: document.kind, fromId: document.id, targetKind: link.kind, targetId: link.id, description: link.description }))).filter(link => (link.fromKind === kind && link.fromId === id) || (link.targetKind === kind && link.targetId === id))
    const memberships = snapshot.items.filter(item => item.document.kind === 'item' && (kind === 'topic' ? item.document.topicIds.includes(id) : item.document.id === id)).map(item => ({ itemId: item.document.id, topicIds: item.document.topicIds }))
    return { links, memberships, references: found.references, scope: 'recorded' as const, coverage: 'unknown' as const }
  }
  async consistency(signal?: AbortSignal) {
    const snapshot = await this.store.snapshot(signal)
    return { checked: snapshot.items.length, scope: 'recorded' as const, findings: [], unchecked: ['外部资料现状、规则语义、角色认知与未记录内容'] }
  }
}
