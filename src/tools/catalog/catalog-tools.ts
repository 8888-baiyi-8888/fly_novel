import { defineTool, type ToolAgentIdentity, type ToolRunContext } from '@fly-novel/tools'
import { z } from 'zod'
import type { JsonValue } from '@fly-novel/util'
import { CatalogError, type CatalogBinding } from '../../world-init/workspace/catalog/service.js'

const path = z.string().min(1)
const registerInput = z.object({ path, summary: z.string().min(1) }).strict()
const updateInput = registerInput.extend({ revision: z.string().min(1), receipt: z.string().min(1) }).strict()
const removeInput = z.object({ path, revision: z.string().min(1) }).strict()
const readInput = z.object({ path }).strict()
const searchInput = z.object({ ownerAgentId: z.string().optional(), keyword: z.string().optional(),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional(), version: z.string().optional() }).strict()
const checkInput = searchInput.pick({ offset: true, limit: true, version: true })
const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }

/** 为一个可信 Agent 绑定资料目录工具；身份和业务权限不由模型指定。 */
export function createCatalogTools(binding: CatalogBinding, identity: ToolAgentIdentity) {
  if (!identity) throw new Error('资料目录工具需要所属 Agent 身份')
  const authorize = (exec: ToolRunContext) => { if (exec.agent !== identity) throw Object.assign(new Error('资料目录工具身份不匹配'), { code: 'CATALOG_FORBIDDEN' }) }
  const safe = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run() } catch (error) {
      if (error instanceof CatalogError) throw error
      if (error instanceof z.ZodError) throw new CatalogError('CATALOG_INVALID_INPUT', '资料目录参数无效', { cause: error })
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) throw new CatalogError('CATALOG_NOT_FOUND', '资料文件不存在', { cause: error })
      throw new CatalogError('CATALOG_IO_ERROR', '资料目录操作失败', { cause: error })
    }
  }
  const mutation = async <T>(exec: ToolRunContext, operation: string, target: string, run: () => Promise<T>): Promise<T | { status: 'unknown'; operation: string; path: string }> => {
    authorize(exec)
    try { return await safe(run) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'CATALOG_COMMIT_UNKNOWN') return { status: 'unknown', operation, path: target }
      throw error
    }
  }
  return [
    defineTool({ name: 'catalog_register', description: '登记自己目录中的成果文件；登记不确认事实。', reportOnAbort: true,
      parameters: { path: { type: 'string', required: true }, summary: { type: 'string', required: true } }, output,
      async execute(args, exec) { const input = registerInput.parse(args); return mutation(exec, 'register', input.path, async () => ({ status: 'registered', ...await binding.register(input.path, input.summary, exec.signal) })) } }),
    defineTool({ name: 'catalog_update', description: '根据完整读取的成果更新自己登记的简介，必须提供 revision 和读取凭据。', reportOnAbort: true,
      parameters: { path: { type: 'string', required: true }, summary: { type: 'string', required: true }, revision: { type: 'string', required: true }, receipt: { type: 'string', required: true } }, output,
      async execute(args, exec) { const input = updateInput.parse(args); return mutation(exec, 'update', input.path, async () => ({ status: 'updated', ...await binding.update(input.path, input.summary, input.revision, input.receipt, exec.signal) })) } }),
    defineTool({ name: 'catalog_read_source', description: '完整读取自己负责的成果并取得更新简介所需的一次性凭据。', reportOnAbort: true,
      parameters: { path: { type: 'string', required: true }, revision: { type: 'string', required: true } }, output,
      async execute(args, exec): Promise<JsonValue> { authorize(exec); const input = removeInput.parse(args); return { ...await safe(() => binding.readSource(input.path, input.revision, exec.signal)) } } }),
    defineTool({ name: 'catalog_read_shared_source', description: '按目录记录版本完整读取同世界已登记成果，返回实际内容摘要及目录是否过期；不授予更新凭据。',
      parameters: { path: { type: 'string', required: true }, revision: { type: 'string', required: true } }, output,
      async execute(args, exec): Promise<JsonValue> { authorize(exec); const input = removeInput.parse(args); return { ...await safe(() => binding.readSharedSource(input.path, input.revision, exec.signal)) } } }),
    defineTool({ name: 'catalog_remove', description: '删除自己的目录记录，不删除成果文件。', reportOnAbort: true,
      parameters: { path: { type: 'string', required: true }, revision: { type: 'string', required: true } }, output,
      async execute(args, exec) { const input = removeInput.parse(args); return mutation(exec, 'remove', input.path, async () => ({ status: 'removed', ...await binding.remove(input.path, input.revision, exec.signal) })) } }),
    defineTool({ name: 'catalog_read', description: '读取世界资料目录中的记录及文件状态。',
      parameters: { path: { type: 'string', required: true } }, output,
      async execute(args, exec): Promise<JsonValue> { authorize(exec); const input = readInput.parse(args); const result = await safe(() => binding.read(input.path, exec.signal)); return result ? { status: 'found', record: { ...result.record }, fileStatus: result.fileStatus } : { status: 'not_registered', path: input.path } } }),
    defineTool({ name: 'catalog_search', description: '查询世界资料目录，按负责人和简介筛选；翻页需携带版本。',
      parameters: { ownerAgentId: { type: 'string' }, keyword: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' }, version: { type: 'string' } }, output,
      async execute(args, exec): Promise<JsonValue> { authorize(exec); const result = await safe(() => binding.search(searchInput.parse(args), exec.signal)); return { ...result, items: result.items.map(item => ({ record: { ...item.record }, fileStatus: item.fileStatus })) } } }),
    defineTool({ name: 'catalog_check_page', description: '检查已登记成果的一页。按顺序从 0 开始并携带同一版本取得所有有效页，才能报告全量检查完成；取消时返回已完成项。', reportOnAbort: true,
      parameters: { offset: { type: 'integer' }, limit: { type: 'integer' }, version: { type: 'string' } }, output,
      async execute(args, exec): Promise<JsonValue> { authorize(exec); const result = await safe(() => binding.checkPage(checkInput.parse(args), exec.signal)); return { ...result, items: result.items.map(item => ({ record: { ...item.record }, fileStatus: item.fileStatus })) } } }),
  ] as const
}
