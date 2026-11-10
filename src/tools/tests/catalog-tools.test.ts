import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { ToolCallId } from '@fly-novel/llm'
import { ToolsService } from '@fly-novel/tools'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import { CatalogError, CatalogService, type CatalogBinding } from '../../world-init/workspace/catalog/service.js'
import type { WorldWorkspaceConfig } from '../../world-init/workspace/config.js'
import { createCatalogTools } from '../catalog/catalog-tools.js'

test('目录工具绑定实例身份和业务身份，按负责人隔离修改并允许查询', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'catalog-tools-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['main', 'creator', 'other', 'catalog', 'confirmed']) await mkdir(join(root, dir))
  const world: WorldWorkspaceConfig = { worldId: root, readRoot: root, catalogRoot: join(root, 'catalog'), confirmedRoot: join(root, 'confirmed'),
    mainAgent: { agentId: 'main', writableRoot: join(root, 'main') }, agents: [{ agentId: 'creator', writableRoot: join(root, 'creator') }, { agentId: 'other', writableRoot: join(root, 'other') }] }
  await initializeCatalog(world.catalogRoot, world.worldId)
  await writeFile(join(root, 'creator', 'profile.md'), '建议')
  await writeFile(join(root, 'other', 'work.md'), '成果')
  const service = await CatalogService.open(world, { singleWriterProcess: true })
  t.after(() => service.close())
  const make = (id: string) => {
    const tools = new ToolsService({ id: `instance-${id}`, name: id, role: 'general' })
    const identity = tools.agent; assert.ok(identity)
    const definitions = createCatalogTools(service.bind(id), identity)
    for (const tool of definitions) tools.register(tool)
    return { tools, definitions }
  }
  const main = make('main'); const creator = make('creator'); const other = make('other')
  const call = async (tools: ToolsService, name: string, args: object) => (await tools.execute({
    calls: [{ type: 'tool-call', id: 'call' as ToolCallId, name, arguments: JSON.stringify(args) }],
    workingDirectory: root, signal: new AbortController().signal,
  })).results[0]!.result
  const created = await call(creator.tools, 'catalog_register', { path: 'creator/profile.md', summary: '角色建议' })
  assert.equal(created.isError, false)
  assert.equal((await call(other.tools, 'catalog_register', { path: 'other/work.md', summary: '其他成果' })).isError, false)
  const found = await call(main.tools, 'catalog_search', { ownerAgentId: 'creator' })
  assert.equal(found.isError, false)
  if (found.isError || !found.value || typeof found.value !== 'object' || Array.isArray(found.value)) throw new Error('查询失败')
  assert.equal(found.value.total, 1)
  assert.equal((await call(main.tools, 'catalog_remove', { path: 'creator/profile.md', revision: 'wrong' })).isError, true)
  assert.equal((await call(creator.tools, 'catalog_register', { path: 'creator/profile.md', summary: '伪造', ownerAgentId: 'main' })).isError, true)
  const tool = creator.definitions[0]!
  await assert.rejects(tool.execute({ path: 'creator/profile.md', summary: '伪造' }, { callId: 'id' as ToolCallId, name: tool.name,
    agent: main.tools.agent, workingDirectory: root, signal: new AbortController().signal }), /身份不匹配/)
  creator.tools.dispose()
  assert.equal((await call(main.tools, 'catalog_read', { path: 'other/work.md' })).isError, false)
  main.tools.dispose(); other.tools.dispose()
})

test('发布结果不确定且信号取消时保留结构化结果', async () => {
  const tools = new ToolsService({ id: 'agent', name: 'agent', role: 'general' })
  const identity = tools.agent; assert.ok(identity)
  const controller = new AbortController()
  const binding: CatalogBinding = {
    async register() { controller.abort(); throw new CatalogError('CATALOG_COMMIT_UNKNOWN', '结果未知') },
    async update() { throw new Error('unused') }, async remove() { throw new Error('unused') },
    async read() { return undefined }, async search() { return { items: [], total: 0, offset: 0, nextOffset: null, version: 'v' } },
  }
  for (const tool of createCatalogTools(binding, identity)) tools.register(tool)
  const result = (await tools.execute({ calls: [{ type: 'tool-call', id: 'id' as ToolCallId, name: 'catalog_register',
    arguments: JSON.stringify({ path: 'main/a.md', summary: '摘要' }) }], workingDirectory: '.', signal: controller.signal })).results[0]!.result
  assert.equal(result.isError, false)
  if (result.isError || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) throw new Error('结果无效')
  assert.equal(result.value.status, 'unknown')
  assert.equal(result.value.operation, 'register')
  tools.dispose()
})
