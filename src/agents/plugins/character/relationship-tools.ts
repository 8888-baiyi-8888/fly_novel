import { defineTool } from '@fly-novel/tools'
import { z } from 'zod'
import { characterRelationshipSchema, type CharacterRelationship } from './relationship-format.js'
import type { CharacterRelationshipStore } from './relationship-store.js'

const participant = z.discriminatedUnion('kind', [z.object({ kind: z.literal('linked'), id: z.string() }).strict(),
  z.object({ kind: z.literal('unresolved'), description: z.string() }).strict()])
const creation = z.object({ participants: z.tuple([participant, participant]), relations: z.array(z.object({ name: z.string(),
  direction: z.enum(['a-to-b', 'b-to-a', 'two-way']), description: z.string() }).strict()) }).strict()
const content = z.object({ participants: characterRelationshipSchema.shape.participants,
  relations: z.array(characterRelationshipSchema.shape.relations.element.extend({ id: z.string().optional() })) }).strict()
const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
const idSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

/** 由可信应用绑定规划者读取；此工具集不适合作为角色视角或未经授权的文件访问接口。 */
export function createCharacterRelationshipTools(store: CharacterRelationshipStore, config: {
  worldId: string
  resolvePerson(id: string, signal: AbortSignal): Promise<{ id: string; worldId: string; name: string } | null>
}) {
  if (config.worldId !== store.worldId || typeof config.resolvePerson !== 'function') throw new Error('人物关系工具的世界或解析器绑定无效')
  async function person(id: string, signal: AbortSignal) {
    idSchema.parse(id)
    signal.throwIfAborted()
    const result = await config.resolvePerson(id, signal)
    signal.throwIfAborted()
    if (result && (result.id !== id || result.worldId !== config.worldId)) throw new Error('人物解析身份或世界不匹配')
    return result
  }
  async function display(document: CharacterRelationship, signal: AbortSignal) {
    const people = []
    for (const endpoint of document.participants) {
      if (endpoint.kind === 'unresolved') people.push({ kind: 'unresolved', clueId: endpoint.clueId, description: endpoint.description })
      else {
        const found = await person(endpoint.id, signal)
        people.push(found ? { kind: 'linked', id: endpoint.id, name: found.name } : { kind: 'missing', id: endpoint.id })
      }
    }
    return people
  }
  return [
    defineTool({ name: 'character_relationship_create', description: '创建初始化时已存在的人物关系；ID 由服务生成。', reportOnAbort: true,
      parameters: { relationship: { type: 'json', required: true, description: '包含两个 participants 和 relations；未建档人物以 unresolved 线索表示。' } }, output,
      async execute({ relationship }, exec) { return JSON.stringify(await store.create(creation.parse(relationship), exec.signal)) } }),
    defineTool({ name: 'character_relationship_read', description: '按关系 ID 读取公共关系及当前人物名称。',
      parameters: { id: { type: 'string', required: true, description: '关系文档 ID。' } }, output,
      async execute({ id }, exec) { const value = await store.read(id, exec.signal); return JSON.stringify({ ...value, people: await display(value.document, exec.signal) }) } }),
    defineTool({ name: 'character_relationship_search', description: '按人物 ID 查询公共关系；方向相对于该人物，不推断对方态度。',
      parameters: { personId: { type: 'string', required: true, description: '已建档人物 ID。' }, direction: { type: 'string', description: 'outgoing、incoming 或 two-way。' },
        keyword: { type: 'string', description: '关系名称或说明包含的关键词。' }, offset: { type: 'integer', description: '结果起点。' },
        limit: { type: 'integer', description: '每页最多 100 项。' }, version: { type: 'string', description: '后续页使用上次的关系结果版本。' } }, output,
      async execute({ personId, direction, keyword, offset, limit, version }, exec) {
        if (!await person(personId, exec.signal)) throw new Error('查询人物不存在')
        const page = await store.query({ personId, direction: z.enum(['outgoing', 'incoming', 'two-way']).optional().parse(direction), keyword, offset, limit, version }, exec.signal)
        const items = []
        for (const item of page.items) items.push({ ...item, people: await display(item.document, exec.signal) })
        return JSON.stringify({ ...page, items })
      } }),
    defineTool({ name: 'character_relationship_update', description: '按读取版本替换未确认关系的完整内容；保留无需修改的条目。', reportOnAbort: true,
      parameters: { id: { type: 'string', required: true, description: '关系文档 ID。' }, version: { type: 'string', required: true, description: '读取获得的版本。' },
        content: { type: 'json', required: true, description: '包含完整 participants 和 relations；已有条目保留 ID，新条目省略 ID。' } }, output,
      async execute({ id, version, content: value }, exec) { return JSON.stringify(await store.update(id, version, content.parse(value), exec.signal)) } }),
  ] as const
}
