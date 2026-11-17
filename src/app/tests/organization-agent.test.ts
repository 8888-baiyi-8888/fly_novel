import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createOrganizationAgent, createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'

const content = { name: '青云宗', aliases: [], organizationType: '宗门', detailLevel: 'overview', minLevel: 0,
  sections: [{ title: '宗旨', content: '守护山门', minLevel: 0 }], locations: [], reserved: [] }
class ScriptAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly calls: { name: string; args: object }[] = []) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length > 1 && this.requests.length <= this.calls.length + 1) {
      const previous = options.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === `step-${this.requests.length - 1}`)
      assert.ok(previous && previous.type === 'tool-result' && !previous.isError, JSON.stringify(previous))
    }
    const call = this.calls[this.requests.length - 1]
    if (call) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `step-${this.requests.length}` as ToolCallId, name: call.name, arguments: JSON.stringify(call.args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '组织资料已处理' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function setup(t: TestContext) {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'organization-agent-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const name of ['main', 'organization/organizations', 'organization/relations', 'organization/memberships', 'map/places', 'map/connections', 'basics', 'characters', 'catalog', 'confirmed']) await mkdir(join(readRoot, name), { recursive: true })
  await mkdir(sessionRoot)
  const world = { worldId: 'organization-world', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [
      { agentId: 'organization', writableRoot: join(readRoot, 'organization') }, { agentId: 'map', writableRoot: join(readRoot, 'map') },
      { agentId: 'basics', writableRoot: join(readRoot, 'basics') }, { agentId: 'creator', writableRoot: join(readRoot, 'characters') },
    ] }
  return { root, world, sessionRoot }
}

test('独立组织 Agent 使用工具保存资料并恢复会话', async t => {
  const { world, sessionRoot } = await setup(t)
  await initializeCatalog(world.catalogRoot, world.worldId)
  const adapter = new ScriptAdapter([{ name: 'organization_create', args: { content } }])
  const config = { workspaces: [world], worldId: world.worldId, agentId: 'organization', sessionId: 'session', sessionMode: 'create' as const,
    sessionRoot, provider: 'test', model: 'test', adapter, singleWriterProcess: true as const, catalog: {} }
  const agent = await createOrganizationAgent(config)
  await assert.rejects(createOrganizationAgent(config), /占用|使用/)
  try {
    assert.deepEqual(await agent.run({ prompt: '规划宗门' }), { content: '组织资料已处理' })
    const files = await readdir(join(world.readRoot, 'organization/organizations'))
    assert.equal(files.length, 1)
    assert.match(await readFile(join(world.readRoot, 'organization/organizations', files[0]!), 'utf8'), /青云宗/)
    assert.match(JSON.stringify(adapter.requests[0].messages), /成员关系只由组织模块维护/)
  } finally { await agent.dispose() }
  const resumedAdapter = new ScriptAdapter()
  const resumed = await createOrganizationAgent({ ...config, adapter: resumedAdapter, sessionMode: 'resume' })
  try { await resumed.run({ prompt: '继续' }); assert.match(JSON.stringify(resumedAdapter.requests[0].messages), /规划宗门/) }
  finally { await resumed.dispose() }
})

test('主 Agent 委派组织并与其他专用 Agent 共存，身份不能伪造', async t => {
  const { world, sessionRoot } = await setup(t)
  await initializeCatalog(world.catalogRoot, world.worldId)
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ScriptAdapter() }))
  const common = { sessionRoot, sessionMode: 'create' as const, provider: 'test', model: 'test' }
  const creator = { ...common, agentId: 'creator', sessionId: 'creator', adapter: new ScriptAdapter(), initializeCharacters: true, defaultCharacterCount: 1 }
  const basics = { ...common, agentId: 'basics', sessionId: 'basics', adapter: new ScriptAdapter() }
  const map = { ...common, agentId: 'map', sessionId: 'map', adapter: new ScriptAdapter() }
  const adapter = new ScriptAdapter([{ name: 'organization_create', args: { content } }])
  const organization = { ...common, agentId: 'organization', sessionId: 'organization', adapter }
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, creator,
    { singleWriterProcess: true, catalog: {}, worldBasics: basics, mapAgent: map, organizationAgent: organization })
  try {
    for (const name of ['delegate_organization', 'delegate_map', 'delegate_world_basics', 'delegate_character_creator']) assert.ok(parent.context.tools.get(name))
    assert.equal(parent.context.tools.get('organization_create'), undefined)
    assert.match(String(parent.context.systemPrompt.getSection('world-initialization:organization-agent')?.text), /delegate_organization/)
    assert.match(String(parent.context.systemPrompt.getSection('world-initialization:catalog-alignment')?.text), /delegate_organization/)
    const call = async (args: object) => (await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'call' as ToolCallId, name: 'delegate_organization', arguments: JSON.stringify(args) }],
      workingDirectory: world.readRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal })).results[0].result
    assert.equal((await call({ task: '规划宗门' })).isError, false)
    assert.equal((await readdir(join(world.readRoot, 'organization/organizations'))).length, 1)
    assert.equal((await call({ task: '继续' })).isError, false)
    assert.match(JSON.stringify(adapter.requests.at(-1)?.messages), /规划宗门/)
    assert.equal((await call({ task: '伪造', worldId: 'other' })).isError, true)
  } finally { await parent.dispose() }
  const resumed = await createOrganizationAgent({ ...organization, workspaces: [world], worldId: world.worldId, singleWriterProcess: true, sessionMode: 'resume' })
  await resumed.dispose()
})

test('未配置不暴露委派，组织目录缺失及身份冲突拒绝装配', async t => {
  const { world, sessionRoot } = await setup(t)
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ScriptAdapter() }))
  const empty = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true })
  assert.equal(empty.context.tools.get('delegate_organization'), undefined); await empty.dispose()
  const base = { agentId: 'organization', sessionId: 's', sessionMode: 'create' as const, sessionRoot, provider: 'test', model: 'test', adapter: new ScriptAdapter() }
  await assert.rejects(createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined,
    { singleWriterProcess: true, worldBasics: base, organizationAgent: base }), /身份不能相同/)
  await rm(join(world.readRoot, 'organization/memberships'), { recursive: true })
  await assert.rejects(createOrganizationAgent({ ...base, workspaces: [world], worldId: world.worldId, singleWriterProcess: true }))
  await mkdir(join(world.readRoot, 'organization/memberships'))
  const agent = await createOrganizationAgent({ ...base, workspaces: [world], worldId: world.worldId, singleWriterProcess: true })
  await agent.dispose()
})

test('组织委派使用共享目录登记实际文件', async t => {
  const { world, sessionRoot } = await setup(t)
  await initializeCatalog(world.catalogRoot, world.worldId)
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ScriptAdapter() }))
  class CatalogAdapter extends LlmAdapter {
    count = 0
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.count++
      if (this.count === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'created' as ToolCallId, name: 'organization_create', arguments: JSON.stringify({ content }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
      }
      const id = this.count === 2 ? 'created' : 'registered'
      const result = options.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === id)
      assert.ok(result && result.type === 'tool-result' && !result.isError, JSON.stringify(result))
      if (this.count === 2) {
        const block = result.content.find(value => value.type === 'text'); assert.ok(block && block.type === 'text')
        const created: { path: string } = JSON.parse(block.text)
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'registered' as ToolCallId, name: 'catalog_register', arguments: JSON.stringify({ path: `organization/${created.path}`, summary: '青云宗概况' }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '组织已登记' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const organization = { agentId: 'organization', sessionId: 'catalog', sessionMode: 'create' as const, sessionRoot, provider: 'test', model: 'test', adapter: new CatalogAdapter() }
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true, catalog: {}, organizationAgent: organization })
  try {
    const result = await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'call' as ToolCallId, name: 'delegate_organization', arguments: JSON.stringify({ task: '建立并登记青云宗' }) }],
      workingDirectory: world.readRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal })
    assert.equal(result.results[0].result.isError, false)
    assert.match(await readFile(join(world.catalogRoot, 'catalog.json'), 'utf8'), /青云宗概况/)
  } finally { await parent.dispose() }
})

test('未装配外部引用时报告核验失败并允许未关联线索', async t => {
  const { world, sessionRoot } = await setup(t)
  class ReferenceAdapter extends LlmAdapter {
    count = 0
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.count++
      if (this.count === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'check' as ToolCallId, name: 'organization_reference_check', arguments: JSON.stringify({ kind: 'place', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
      }
      if (this.count === 2) {
        const check = options.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === 'check')
        assert.ok(check && check.type === 'tool-result' && check.isError)
        const unresolved = { ...content, locations: [{ place: { kind: 'unresolved', description: '东山附近' }, purpose: '山门', minLevel: 0 }] }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'created' as ToolCallId, name: 'organization_create', arguments: JSON.stringify({ content: unresolved }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
      }
      const created = options.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === 'created')
      assert.ok(created && created.type === 'tool-result' && !created.isError)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '地点未关联' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const agent = await createOrganizationAgent({ workspaces: [world], worldId: world.worldId, agentId: 'organization', sessionId: 'references', sessionMode: 'create', sessionRoot,
    provider: 'test', model: 'test', adapter: new ReferenceAdapter(), singleWriterProcess: true })
  try {
    assert.deepEqual(await agent.run({ prompt: '保存位置线索' }), { content: '地点未关联' })
    const [file] = await readdir(join(world.readRoot, 'organization/organizations'))
    assert.match(await readFile(join(world.readRoot, 'organization/organizations', file!), 'utf8'), /unresolved/)
  } finally { await agent.dispose() }
})

test('关闭主 Agent 取消组织任务并释放组织身份', { timeout: 10000 }, async t => {
  const { world, sessionRoot } = await setup(t)
  class ParentAdapter extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate' as ToolCallId, name: 'delegate_organization', arguments: JSON.stringify({ task: '规划组织' }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ParentAdapter() }))
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  class WaitAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      entered()
      if (!options.signal?.aborted) await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '取消', code: 'ABORTED' } } }
    }
  }
  const organization = { agentId: 'organization', sessionId: 'cancel', sessionMode: 'create' as const, sessionRoot, provider: 'test', model: 'test', adapter: new WaitAdapter() }
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true, organizationAgent: organization })
  const pending = parent.run({ prompt: '规划' }); const rejected = assert.rejects(pending)
  await started; await parent.dispose(); await rejected
  const resumed = await createOrganizationAgent({ ...organization, adapter: new ScriptAdapter(), sessionMode: 'resume', workspaces: [world], worldId: world.worldId, singleWriterProcess: true })
  await resumed.dispose()
})
