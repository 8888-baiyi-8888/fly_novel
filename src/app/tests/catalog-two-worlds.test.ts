import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapAgents, type Agent } from '@fly-novel/agents'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { createCatalogTools } from '../../tools/catalog/catalog-tools.js'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import { CatalogService } from '../../world-init/workspace/catalog/service.js'
import type { WorldWorkspaceConfig } from '../../world-init/workspace/config.js'

class ParentAdapter extends LlmAdapter {
  override async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
class ChildAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly label: string) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'create' as ToolCallId, name: 'character_create',
        arguments: JSON.stringify({ character: { name: '同名角色', summary: this.label, categories: {}, body: this.label } }) } }
    } else if (this.requests.length === 2) {
      const result = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'create')
      assert.ok(result && result.type === 'tool-result')
      const text = result.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text')
      const data: unknown = JSON.parse(text.text)
      assert.ok(data && typeof data === 'object' && 'id' in data && typeof data.id === 'string')
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'register' as ToolCallId, name: 'catalog_register',
        arguments: JSON.stringify({ path: `characters/${data.id}/profile.md`, summary: this.label }) } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已登记建议' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

test('两个世界的主 Agent、角色 Agent 和测试特殊 Agent 分别登记并隔离资料', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'catalog-worlds-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessionRoot = join(root, 'sessions'); await mkdir(sessionRoot)
  const make = async (id: string): Promise<WorldWorkspaceConfig> => {
    const readRoot = join(root, id)
    for (const dir of ['main', 'characters', 'other', 'catalog', 'confirmed']) await mkdir(join(readRoot, dir), { recursive: true })
    const world: WorldWorkspaceConfig = { worldId: `two-worlds-${id}`, readRoot, catalogRoot: join(readRoot, 'catalog'),
      confirmedRoot: join(readRoot, 'confirmed'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') },
      agents: [{ agentId: 'creator', writableRoot: join(readRoot, 'characters') }, { agentId: 'other', writableRoot: join(readRoot, 'other') }] }
    await initializeCatalog(world.catalogRoot, world.worldId)
    await writeFile(join(readRoot, 'main', 'world.md'), `world ${id}`)
    await writeFile(join(readRoot, 'other', 'work.md'), `special ${id}`)
    return world
  }
  const a = await make('a'); const b = await make('b'); const worlds = [a, b]
  const adapter = new ParentAdapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter }))
  const deployment = { singleWriterProcess: true, catalog: {} } as const
  const childConfig = (label: string) => ({ agentId: 'creator', sessionId: 'same-session', sessionMode: 'create' as const, sessionRoot,
    initializeCharacters: true, provider: 'test', model: 'test', adapter: new ChildAdapter(label), defaultCharacterCount: 2 })
  const parentA = await createWorldInitializationAgentWithWorldWorkspaces(worlds, a.worldId, childConfig('建议 A'), deployment)
  t.after(() => parentA.dispose())
  const parentB = await createWorldInitializationAgentWithWorldWorkspaces(worlds, b.worldId, childConfig('建议 B'), deployment)
  t.after(() => parentB.dispose())
  const call = async (agent: Agent, world: WorldWorkspaceConfig, name: string, args: object) => (await agent.context.tools.execute({
    calls: [{ type: 'tool-call', id: 'call' as ToolCallId, name, arguments: JSON.stringify(args) }],
    workingDirectory: world.readRoot, session: agent.context.sessions.list()[0]!, signal: new AbortController().signal,
  })).results[0]!.result
  for (const [agent, world, other] of [[parentA, a, b], [parentB, b, a]] as const) {
    const created = await call(agent, world, 'catalog_register', { path: 'main/world.md', summary: world.worldId })
    assert.equal(created.isError, false)
    assert.equal((await call(agent, world, 'delegate_character_creator', { task: '创建并登记角色' })).isError, false)
    const results = await call(agent, world, 'catalog_search', { ownerAgentId: 'creator' })
    assert.equal(results.isError, false)
    if (results.isError || !results.value || typeof results.value !== 'object' || Array.isArray(results.value)) throw new Error('查询失败')
    assert.equal(results.value.total, 1)
    assert.doesNotMatch(JSON.stringify(results.value), new RegExp(other.worldId === a.worldId ? '建议 A' : '建议 B'))
    assert.equal((await call(agent, world, 'catalog_register', { path: join(other.readRoot, 'main', 'world.md'), summary: '越界' })).isError, true)
    assert.equal((await call(agent, world, 'catalog_register', { path: '../b/main/world.md', summary: '越界' })).isError, true)
    assert.equal((await call(agent, world, 'catalog_register', { path: 'catalog/catalog.json', summary: '目录' })).isError, true)
    assert.equal((await call(agent, world, 'catalog_register', { path: 'confirmed/fact.md', summary: '确认' })).isError, true)
    assert.equal((await call(agent, world, 'catalog_register', { path: 'main/missing.md', summary: '缺失' })).isError, true)
    if (process.platform === 'win32') assert.equal((await call(agent, world, 'catalog_register', { path: 'MAIN/WORLD.MD', summary: '别名' })).isError, true)
    const own = await call(agent, world, 'catalog_read', { path: 'main/world.md' })
    assert.ok(!own.isError && own.value && typeof own.value === 'object' && !Array.isArray(own.value))
    const record = own.value.record
    assert.ok(record && typeof record === 'object' && !Array.isArray(record) && typeof record.revision === 'string')
    const source = await call(agent, world, 'catalog_read_source', { path: 'main/world.md', revision: record.revision })
    assert.ok(!source.isError && source.value && typeof source.value === 'object' && !Array.isArray(source.value) && typeof source.value.receipt === 'string')
    const updated = await call(agent, world, 'catalog_update', { path: 'main/world.md', summary: '更新建议', revision: record.revision, receipt: source.value.receipt })
    assert.equal(updated.isError, false)
    assert.ok(!updated.isError && updated.value && typeof updated.value === 'object' && !Array.isArray(updated.value))
    const updatedRecord = updated.value.record
    assert.ok(updatedRecord && typeof updatedRecord === 'object' && !Array.isArray(updatedRecord) && typeof updatedRecord.revision === 'string')
    assert.equal((await call(agent, world, 'catalog_remove', { path: 'main/world.md', revision: updatedRecord.revision })).isError, false)
    assert.match(await readFile(join(world.readRoot, 'main', 'world.md'), 'utf8'), /world/)
  }
  await t.test('目录链接不能用于跨世界登记', async subtest => {
    try { await symlink(b.mainAgent.writableRoot, join(a.mainAgent.writableRoot, 'link'), process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error) {
      if (error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) {
        subtest.skip(`无法创建目录链接：${String(error.code)}`); return
      }
      throw error
    }
    assert.equal((await call(parentA, a, 'catalog_register', { path: 'main/link/world.md', summary: '越界' })).isError, true)
  })
  await parentA.dispose(); await parentB.dispose()

  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const base = framework.presets.get('generic-subagent')
  framework.presets.register({ ...base, id: 'catalog-test-special', plugins: [...base.plugins, { pluginId: 'tools' }] })
  for (const world of worlds) {
    const service = await CatalogService.open(world, { singleWriterProcess: true })
    try {
      const special = await framework.manager.create({ id: `special-${world.worldId}`, presetId: 'catalog-test-special', pluginConfigs: {
        'agent-loop-runtime': { provider: 'test', model: 'test', workingDirectory: world.readRoot },
        llm: { adapters: [{ providers: ['test'], adapter }] },
      } })
      const identity = special.context.tools.agent; assert.ok(identity)
      for (const tool of createCatalogTools(service.bind('other'), identity)) special.context.tools.register(tool)
      assert.equal((await call(special, world, 'catalog_register', { path: 'other/work.md', summary: `成果 ${world.worldId}` })).isError, false)
      assert.equal((await call(special, world, 'catalog_search', { ownerAgentId: 'creator' })).isError, false)
      await framework.manager.dispose(special.info.identity.id)
    } finally { await service.close() }
    assert.match(await readFile(join(world.catalogRoot, 'catalog.json'), 'utf8'), /成果/)
  }
})
