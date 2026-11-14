import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'

function call(id: string, name: string, args: object): StreamChunk {
  return { type: 'block-end', index: 0, block: { type: 'tool-call', id: id as ToolCallId, name, arguments: JSON.stringify(args) } }
}

function result(options: GenerateOptions, id: string): string {
  const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === id)
  assert.ok(block && block.type === 'tool-result' && !block.isError, `工具 ${id} 失败：${JSON.stringify(block)}`)
  return JSON.stringify(block.content)
}

class BasicsAdapter extends LlmAdapter {
  private step = 0
  constructor(private readonly city: boolean) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step++
    if (this.city && this.step === 1) {
      yield call('source', 'read_file', { path: 'confirmed/water.md' })
    } else if (this.step === (this.city ? 2 : 1)) {
      if (this.city) assert.match(result(options, 'source'), /水源有限/)
      const content = this.city
        ? '用户要求：城邦资源有限。来源：confirmed/water.md。建议：城邦协商供水。明确留白：外海。'
        : '用户要求：力量无善恶。建议：修行群体各有规范。留白：远方地区。'
      yield call('save', 'save_world_basics', { content })
    } else {
      const saved = result(options, 'save')
      const path = saved.match(/basics\/world-basics-[a-f0-9-]+\.md/)
      assert.ok(path)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `待审成果：${path[0]}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

class ParentAdapter extends LlmAdapter {
  private step = 0
  constructor(private readonly city: boolean) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step++
    if (this.step === 1) {
      yield call('delegate', 'delegate_world_basics', { task: this.city ? '依据 confirmed/water.md 规划城邦群，外海留白' : '规划力量无善恶的修仙世界' })
    } else if (this.step === 2) {
      const delegated = result(options, 'delegate')
      const path = delegated.match(/basics\/world-basics-[a-f0-9-]+\.md/)
      assert.ok(path)
      yield call('read-result', 'read', { file_path: path[0] })
    } else {
      const actual = result(options, 'read-result')
      assert.match(actual, this.city ? /城邦协商供水/ : /修行群体各有规范/)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已读取待审基础信息' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

test('主 Agent 委派两个世界并读取实际待审成果', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'world-basics-e2e-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessionRoot = join(root, 'sessions'); await mkdir(sessionRoot)
  for (const city of [false, true]) {
    const name = city ? 'city' : 'cultivation'; const readRoot = join(root, name)
    for (const dir of ['main', 'basics', 'confirmed', 'catalog']) await mkdir(join(readRoot, dir), { recursive: true })
    if (city) await writeFile(join(readRoot, 'confirmed', 'water.md'), '水源有限\n')
    const world = { worldId: name, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
      mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'basics', writableRoot: join(readRoot, 'basics') }] }
    const parentAdapter = new ParentAdapter(city)
    const mock = t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: parentAdapter }))
    const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, {
      singleWriterProcess: true, worldBasics: { agentId: 'basics', sessionId: 's', sessionMode: 'create', sessionRoot,
        provider: 'test', model: 'test', adapter: new BasicsAdapter(city) },
    })
    try {
      assert.deepEqual(await parent.run({ prompt: city ? '规划城邦群' : '规划修仙世界' }), { content: '已读取待审基础信息' })
      const contents = JSON.stringify(parent.context.sessions.list()[0]!.read())
      const path = contents.match(/basics\/world-basics-[a-f0-9-]+\.md/)
      assert.ok(path)
      const text = await readFile(join(readRoot, path[0]), 'utf8')
      assert.match(text, /世界基础信息（待审）/)
      assert.match(text, city ? /明确留白：外海/ : /留白：远方地区/)
    } finally { await parent.dispose(); mock.mock.restore() }
  }
})
