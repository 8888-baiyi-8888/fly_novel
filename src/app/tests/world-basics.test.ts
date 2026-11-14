import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import { createWorldBasicsAgent, type WorldBasicsConfig } from '../agents/world-basics.js'
import { WorldInitializationDraftFileSystem } from '../agents/world-initialization-draft-fs.js'

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'world-basics-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  await mkdir(readRoot); await mkdir(sessionRoot)
  for (const name of ['main', 'basics', 'confirmed', 'catalog', 'other']) await mkdir(join(readRoot, name))
  const world = { worldId: 'world', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') },
    agents: [{ agentId: 'basics', writableRoot: join(readRoot, 'basics') }, { agentId: 'other', writableRoot: join(readRoot, 'other') }] }
  return { root, world, sessionRoot }
}

class ScriptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly calls: { name: string; args: object }[]) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const call = this.calls[this.requests.length - 1]
    if (call) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-${this.requests.length}` as ToolCallId,
        name: call.name, arguments: JSON.stringify(call.args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '任务结束' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

function config(world: Awaited<ReturnType<typeof setup>>['world'], sessionRoot: string, adapter: LlmAdapter): WorldBasicsConfig {
  return { workspaces: [world], worldId: world.worldId, agentId: 'basics', sessionId: 's', sessionMode: 'create', sessionRoot,
    singleWriterProcess: true, provider: 'test', model: 'test', adapter }
}

test('独立 Agent 读取世界资料并保存独立建议，恢复 Session 和保护其他目录', async t => {
  const { root, world, sessionRoot } = await setup(t)
  await writeFile(join(world.readRoot, 'confirmed', 'source.md'), '水源有限')
  await writeFile(join(root, 'outside.md'), '跨世界秘密')
  const adapter = new ScriptAdapter([
    { name: 'read', args: { file_path: 'confirmed/source.md' } },
    { name: 'read', args: { file_path: join(root, 'outside.md') } },
    { name: 'write', args: { file_path: 'other/invalid.md', content: '无权写入' } },
    { name: 'save_world_basics', args: { content: '用户要求：资源有限。建议：城邦协作。' } },
    { name: 'save_world_basics', args: { content: '用户要求：外海留白。' } },
  ])
  const options = config(world, sessionRoot, adapter)
  const agent = await createWorldBasicsAgent(options)
  await assert.rejects(createWorldBasicsAgent(options), /占用|使用/)
  assert.deepEqual(await agent.run({ prompt: '规划城邦群' }), { content: '任务结束' })
  const messages = JSON.stringify(adapter.requests.at(-1)?.messages)
  assert.match(messages, /水源有限/)
  assert.doesNotMatch(messages, /跨世界秘密/)
  const files = await readdir(join(world.readRoot, 'basics'))
  assert.equal(files.length, 2)
  const contents = await Promise.all(files.map(file => readFile(join(world.readRoot, 'basics', file), 'utf8')))
  assert.ok(contents.some(content => content.includes('城邦协作')))
  assert.ok(contents.some(content => content.includes('外海留白')))
  assert.deepEqual(await readdir(join(world.readRoot, 'other')), [])
  await Promise.all([agent.dispose(), agent.dispose()])
  const resumedAdapter = new ScriptAdapter([])
  const resumed = await createWorldBasicsAgent({ ...options, sessionMode: 'resume', adapter: resumedAdapter })
  try {
    await resumed.run({ prompt: '继续' })
    assert.match(JSON.stringify(resumedAdapter.requests[0]?.messages), /规划城邦群/)
  } finally { await resumed.dispose() }
})

test('资料目录按可信身份登记独立成果', async t => {
  const { world, sessionRoot } = await setup(t)
  await initializeCatalog(world.catalogRoot, world.worldId)
  class CatalogAdapter extends LlmAdapter {
    requests: GenerateOptions[] = []
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      if (this.requests.length === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'save' as ToolCallId, name: 'save_world_basics', arguments: JSON.stringify({ content: '修仙世界建议' }) } }
      } else if (this.requests.length === 2) {
        const blocks = options.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
        const match = JSON.stringify(blocks).match(/basics\/world-basics-[a-f0-9-]+\.md/)
        assert.ok(match)
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'register' as ToolCallId, name: 'catalog_register', arguments: JSON.stringify({ path: match[0], summary: '修仙世界基础信息' }) } }
      } else {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '已保存并登记' } }
        yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  const adapter = new CatalogAdapter()
  const agent = await createWorldBasicsAgent({ ...config(world, sessionRoot, adapter), catalog: {} })
  try {
    await agent.run({ prompt: '规划修仙世界' })
    assert.match(await readFile(join(world.catalogRoot, 'catalog.json'), 'utf8'), /修仙世界基础信息/)
    assert.match(JSON.stringify(adapter.requests.at(-1)?.messages), /registered/)
  } finally { await agent.dispose() }
})

test('保存结果不确定时返回可核查路径并保留已写入成果', async t => {
  const { world, sessionRoot } = await setup(t)
  const adapter = new ScriptAdapter([{ name: 'save_world_basics', args: { content: '世界背景建议' } }])
  const agent = await createWorldBasicsAgent(config(world, sessionRoot, adapter))
  const write = WorldInitializationDraftFileSystem.prototype.writeText
  t.mock.method(WorldInitializationDraftFileSystem.prototype, 'writeText', async function (this: WorldInitializationDraftFileSystem, ...args: Parameters<typeof write>) {
    await write.apply(this, args)
    throw new Error('模拟写入结果不确定')
  })
  try {
    await agent.run({ prompt: '保存建议' })
    const output = JSON.stringify(adapter.requests.at(-1)?.messages)
    assert.match(output, /unknown/)
    const path = output.match(/basics\/world-basics-[a-f0-9-]+\.md/)
    assert.ok(path)
    assert.match(await readFile(join(world.readRoot, path[0]), 'utf8'), /世界背景建议/)
  } finally { await agent.dispose() }
})

test('目录未初始化时启动失败并释放身份，不覆盖已有目录数据', async t => {
  const { world, sessionRoot } = await setup(t)
  const options = config(world, sessionRoot, new ScriptAdapter([]))
  await assert.rejects(createWorldBasicsAgent({ ...options, catalog: {} }))
  assert.deepEqual(await readdir(world.catalogRoot), [])
  const agent = await createWorldBasicsAgent(options)
  await agent.dispose()
})

test('拒绝无效世界、身份和重叠 Session 目录，并在取消后释放身份', async t => {
  const { world, sessionRoot } = await setup(t)
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  class WaitAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      started()
      await new Promise<void>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }))
    }
  }
  const options = config(world, sessionRoot, new WaitAdapter())
  await assert.rejects(createWorldBasicsAgent({ ...options, worldId: 'missing' }), /世界配置不存在/)
  await assert.rejects(createWorldBasicsAgent({ ...options, agentId: 'main' }), /特殊 Agent/)
  await assert.rejects(createWorldBasicsAgent({ ...options, sessionRoot: world.readRoot }), /不能与任何世界读取根重叠/)
  const agent = await createWorldBasicsAgent(options)
  const run = agent.run({ prompt: '等待' })
  await ready; agent.cancel(); await assert.rejects(run); await agent.dispose()
  const resumed = await createWorldBasicsAgent({ ...options, sessionMode: 'resume', adapter: new ScriptAdapter([]) })
  await resumed.dispose()
})
