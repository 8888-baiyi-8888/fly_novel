import { defineTool } from '@fly-novel/tools'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { characterMetadataSchema, requirementsSchema } from '../../world-init/character/format.js'
import type { CharacterStore } from '../../world-init/character/store.js'

const inputSchema = characterMetadataSchema.pick({ name: true, summary: true, categories: true }).extend({ body: z.string() }).strict()
const querySchema = z.object({ name: z.string().optional(), categories: z.record(z.string(), z.array(z.string().min(1)).min(1)).optional() }).strict()

/** 创建供可信调用方注册的角色资料工具；确认提交不向模型暴露。 */
export function createCharacterTools(store: CharacterStore) {
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  return [
    defineTool({ name: 'character_create', description: '创建一份角色建议；角色 ID 由程序生成。', reportOnAbort: true,
      parameters: { character: { type: 'json', required: true, description: '包含 name、summary、categories 和 body 的角色资料。' } }, output,
      async execute({ character }, exec) { exec.signal.throwIfAborted(); return JSON.stringify(await store.create(inputSchema.parse(character))) } }),
    defineTool({ name: 'character_search', description: '按名称或分类分页查询角色；同名返回多个候选。',
      parameters: { filter: { type: 'json', required: true, description: '包含可选 name 和 categories 的查询条件。' },
        offset: { type: 'integer', description: '从零开始的结果位置。' }, limit: { type: 'integer', description: '每页数量，最大 100。' },
        version: { type: 'string', description: '后续页面使用上次结果版本；变化时拒绝继续。' } }, output,
      async execute({ filter, offset, limit, version }, exec) {
        exec.signal.throwIfAborted()
        const start = z.number().int().nonnegative().parse(offset ?? 0)
        const size = z.number().int().min(1).max(100).parse(limit ?? 50)
        const results = await store.query(querySchema.parse(filter))
        const current = createHash('sha256').update(JSON.stringify(results)).digest('hex')
        if (version !== undefined && version !== current) throw new Error('角色查询结果已变化，请重新查询')
        const items = results.slice(start, start + size)
        return JSON.stringify({ items, total: results.length, offset: start, nextOffset: start + items.length < results.length ? start + items.length : null, version: current })
      } }),
    defineTool({ name: 'character_read', description: '按已选角色 ID 读取当前角色资料。',
      parameters: { id: { type: 'string', required: true, description: '角色 ID。' } }, output,
      async execute({ id }, exec) { exec.signal.throwIfAborted(); return JSON.stringify(await store.read(id)) } }),
    defineTool({ name: 'character_read_many', description: '批量读取角色；逐项返回成功或错误。',
      parameters: { ids: { type: 'array', required: true, items: { type: 'string' }, description: '已选角色 ID 列表。' } }, output,
      async execute({ ids }, exec) { exec.signal.throwIfAborted(); return JSON.stringify(await store.readMany(ids)) } }),
    defineTool({ name: 'character_prepare', description: '为选定角色保存待审修改，不确认或覆盖当前资料。', reportOnAbort: true,
      parameters: { id: { type: 'string', required: true, description: '现有角色 ID。' },
        character: { type: 'json', required: true, description: '包含 name、summary、categories 和 body 的完整修改建议。' } }, output,
      async execute({ id, character }, exec) { exec.signal.throwIfAborted(); return JSON.stringify(await store.prepare(id, inputSchema.parse(character))) } }),
    defineTool({ name: 'character_pending_read', description: '读取角色待审修改及基线。',
      parameters: { id: { type: 'string', required: true, description: '现有角色 ID。' } }, output,
      async execute({ id }, exec) { exec.signal.throwIfAborted(); return JSON.stringify(await store.readPending(id)) } }),
    defineTool({ name: 'character_requirements_read', description: '读取角色需求清单及其版本。', parameters: {}, output,
      async execute(_args, exec) { exec.signal.throwIfAborted(); return JSON.stringify(await store.readRequirements()) } }),
    defineTool({ name: 'character_requirements_save', description: '保存角色需求清单；更新时提供读取所得版本。', reportOnAbort: true,
      parameters: { data: { type: 'json', required: true, description: '版本化角色需求清单。' }, body: { type: 'string', required: true, description: '供人阅读的说明。' },
        version: { type: 'string', description: '已有清单的版本；首次创建时省略。' } }, output,
      async execute({ data, body, version }, exec) { exec.signal.throwIfAborted(); return JSON.stringify({ version: await store.saveRequirements(requirementsSchema.parse(data), body, version) }) } }),
  ] as const
}
