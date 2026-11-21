import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { DiscussionService, type DiscussionTargetAdapter } from '../../world-init/discussion/service.js'

class FixedAdapter extends LlmAdapter {
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('讨论入口只读当前世界，不能使用初始化写入工具', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'discussion-isolation-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['main', 'confirmed', 'catalog']) await mkdir(join(root, dir))
  const world = { worldId: 'world', readRoot: root, confirmedRoot: join(root, 'confirmed'), catalogRoot: join(root, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(root, 'main') }, agents: [] }
  const path = join(root, 'main', 'plan.md'); await writeFile(path, '原文')
  const adapter = new FixedAdapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter }))
  const agent = await createWorldInitializationAgentWithWorldWorkspaces([world], 'world', undefined,
    { singleWriterProcess: true, discussion: { firstVersionComplete: true } })
  t.after(() => agent.dispose())
  const call = async (name: string, args: object) => (await agent.context.tools.execute({
    calls: [{ type: 'tool-call', id: 'test' as ToolCallId, name, arguments: JSON.stringify(args) }],
    workingDirectory: root, session: agent.context.sessions.list()[0]!, signal: new AbortController().signal,
  })).results[0]!.result
  assert.equal((await call('read', { file_path: 'main/plan.md' })).isError, false)
  for (const [name, args] of [['write', { file_path: 'main/plan.md', content: '覆盖' }],
    ['save_first_world_plan', { content: '覆盖' }], ['delegate_map', { task: '修改' }]] as const) {
    assert.equal((await call(name, args)).isError, true, name)
  }
  assert.equal(await readFile(path, 'utf8'), '原文')
})

test('讨论委派使用专用身份，但不能调用初始化写工具', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'discussion-child-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const view = join(root, 'world'); const sessions = join(root, 'sessions')
  for (const dir of ['main', 'confirmed', 'catalog', 'map/places', 'map/connections']) await mkdir(join(view, dir), { recursive: true })
  await mkdir(sessions)
  await writeFile(join(view, 'main', 'plan.md'), '原文')
  const world = { worldId: 'world', readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [{ agentId: 'map', writableRoot: join(view, 'map') }] }
  class AttackAdapter extends LlmAdapter {
    requests: GenerateOptions[] = []
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      if (this.requests.length === 1) {
        for (const [index, name] of ['write', 'map_place_create'].entries()) yield { type: 'block-end', index,
          block: { type: 'tool-call', id: name as ToolCallId, name, arguments: JSON.stringify({ file_path: 'main/plan.md', content: '覆盖' }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '已核查' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const adapter = new FixedAdapter(); const child = new AttackAdapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter }))
  const agent = await createWorldInitializationAgentWithWorldWorkspaces([world], 'world', undefined, {
    singleWriterProcess: true, discussion: { firstVersionComplete: true },
    mapAgent: { agentId: 'map', sessionId: 'map', sessionMode: 'create', sessionRoot: sessions, provider: 'test', model: 'test', adapter: child },
  })
  t.after(() => agent.dispose())
  const result = await agent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'delegate' as ToolCallId,
    name: 'delegate_map', arguments: JSON.stringify({ task: '检查地点' }) }], workingDirectory: view,
  session: agent.context.sessions.list()[0]!, signal: new AbortController().signal })
  assert.equal(result.results[0]!.result.isError, false)
  const blocks = child.requests[1]!.messages.flatMap(message => message.content)
  for (const id of ['write', 'map_place_create']) {
    const block = blocks.find(item => item.type === 'tool-result' && item.toolCallId === id)
    assert.ok(block && block.type === 'tool-result' && block.isError, id)
  }
  assert.equal(await readFile(join(view, 'main', 'plan.md'), 'utf8'), '原文')
  const resumed = await agent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'resume' as ToolCallId,
    name: 'delegate_map', arguments: JSON.stringify({ task: '继续讨论' }) }], workingDirectory: view,
  session: agent.context.sessions.list()[0]!, signal: new AbortController().signal })
  assert.equal(resumed.results[0]!.result.isError, false)
  assert.match(JSON.stringify(child.requests[2]!.messages), /检查地点/)
})

test('讨论父 Agent 关闭会取消子任务并释放身份', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'discussion-cancel-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const view = join(root, 'world'); const sessions = join(root, 'sessions')
  for (const dir of ['main', 'confirmed', 'catalog', 'map/places', 'map/connections']) await mkdir(join(view, dir), { recursive: true })
  await mkdir(sessions)
  const world = { worldId: 'cancel-discussion', readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [{ agentId: 'map', writableRoot: join(view, 'map') }] }
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  class ParentAdapter extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate' as ToolCallId,
        name: 'delegate_map', arguments: JSON.stringify({ task: '讨论地点' }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  class WaitingChild extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      enter()
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) reject(options.signal.reason)
        else options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      })
    }
  }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ParentAdapter() }))
  const mapAgent = { agentId: 'map', sessionId: 'map', sessionMode: 'create' as const, sessionRoot: sessions,
    provider: 'test', model: 'test', adapter: new WaitingChild() }
  const options = { singleWriterProcess: true as const, discussion: { firstVersionComplete: true as const }, mapAgent }
  const agent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, options)
  const running = agent.run({ prompt: '讨论' }); const rejected = assert.rejects(running)
  await entered
  await agent.dispose(); await rejected
  const reopened = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, {
    ...options, mapAgent: { ...mapAgent, sessionMode: 'resume', adapter: new FixedAdapter() },
  })
  await reopened.dispose()
})

test('主 Agent 候选工具绑定讨论目标并保留当前正文', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'discussion-binding-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const view = join(root, 'world'); const sessions = join(root, 'sessions'); const pending = join(root, 'pending')
  for (const dir of ['main', 'confirmed', 'catalog']) await mkdir(join(view, dir), { recursive: true })
  for (const dir of [sessions, pending, join(pending, 'discussions'), join(pending, 'candidates')]) await mkdir(dir)
  const world = { worldId: 'binding-world', readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [] }
  const source = join(view, 'main', 'plan.md'); await writeFile(source, '当前正文')
  const target = { kind: 'place' as const, id: '11111111-1111-4111-8111-111111111111' }
  const adapter: DiscussionTargetAdapter = { async read() { return { content: await readFile(source, 'utf8'), version: 'v1' } },
    async validate() {}, async assertNoLegacyCandidate() {} }
  const context = new Context(); const backend = context.plugin(LocalFileSystem, { cwd: root }); await backend
  const service = await DiscussionService.open({ worldId: world.worldId, root: pending, worldRoots: [view], fs: context.fs, adapter, singleWriterProcess: true })
  const record = await service.createDiscussion(target, 'session')
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new FixedAdapter() }))
  const agent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true,
    discussion: { firstVersionComplete: true, binding: { service, discussionId: record.id } },
    mainSession: { sessionRoot: sessions, sessionId: 'session', sessionMode: 'create' } })
  try {
    const call = async (name: string, args: object) => (await agent.context.tools.execute({
      calls: [{ type: 'tool-call', id: 'call' as ToolCallId, name, arguments: JSON.stringify(args) }], workingDirectory: view,
      session: agent.context.sessions.list()[0]!, signal: new AbortController().signal })).results[0]!.result
    assert.equal((await call('discussion_read', {})).isError, false)
    assert.equal((await call('discussion_prepare', { content: '候选正文', summary: '修改' })).isError, false)
    assert.equal((await call('discussion_prepare', { content: '盲目覆盖', summary: '修改' })).isError, true)
    assert.equal((await service.listCandidates(record.id))[0]!.value.content, '候选正文')
    assert.equal(await readFile(source, 'utf8'), '当前正文')
    await agent.run({ prompt: '继续讨论' })
    await agent.dispose()
    const resumed = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true,
      discussion: { firstVersionComplete: true, binding: { service, discussionId: record.id } },
      mainSession: { sessionRoot: sessions, sessionId: 'session', sessionMode: 'resume' } })
    try {
      const result = await resumed.context.tools.execute({ calls: [{ type: 'tool-call', id: 'read' as ToolCallId,
        name: 'discussion_read', arguments: '{}' }], workingDirectory: view, session: resumed.context.sessions.list()[0]!, signal: new AbortController().signal })
      assert.match(JSON.stringify(result.results[0]!.result), /候选正文/)
    } finally { await resumed.dispose() }
  } finally { await agent.dispose(); await service.close(); await backend.dispose() }
})
