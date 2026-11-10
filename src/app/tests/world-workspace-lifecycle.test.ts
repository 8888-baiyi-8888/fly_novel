import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createCharacterCreator, createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import type { WorldWorkspaceConfig } from '../../world-init/workspace/config.js'
import { CharacterStore } from '../../world-init/character/store.js'

class FixedAdapter extends LlmAdapter {
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('世界身份在启动到释放期间独占，失败后可重建并保留目录成果', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'workspace-lifecycle-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const makeWorld = async (worldId: string): Promise<WorldWorkspaceConfig> => {
    const readRoot = join(root, worldId)
    for (const dir of ['main', 'character', 'confirmed', 'catalog']) await mkdir(join(readRoot, dir), { recursive: true })
    return { worldId, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
      mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'creator', writableRoot: join(readRoot, 'character') }] }
  }
  const a = await makeWorld('lease-a'); const b = await makeWorld('lease-b')
  const sessionRoot = join(root, 'sessions'); await mkdir(sessionRoot)
  await writeFile(join(a.mainAgent.writableRoot, 'result.md'), '保留成果')
  let releaseGate!: () => void; let announce!: () => void
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  const entered = new Promise<void>(resolve => { announce = resolve })
  let calls = 0; let fail = false
  const adapter = new FixedAdapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => {
    calls++
    if (calls === 1) { announce(); await gate }
    if (fail) throw new Error('模型装配失败')
    return { provider, model: 'test', adapter }
  })
  const deployment = { singleWriterProcess: true } as const
  const create = (worldId: string) => createWorldInitializationAgentWithWorldWorkspaces([a, b], worldId, undefined, deployment)
  await assert.rejects(Reflect.apply(createWorldInitializationAgentWithWorldWorkspaces, undefined,
    [[a, b], a.worldId, undefined, { singleWriterProcess: false }]), /仅由一个可信应用进程写入/)
  const starting = create(a.worldId)
  await entered
  await assert.rejects(create(a.worldId), /身份正在使用/)
  const other = await create(b.worldId)
  await other.dispose()
  await assert.rejects(createCharacterCreator({ worldId: a.worldId, agentId: 'main', sessionId: 's', sessionMode: 'create',
    sessionRoot, characterRoot: a.agents[0]!.writableRoot, initializeCharacters: true, readRoot: a.readRoot,
    provider: 'test', model: 'test', adapter, defaultCharacterCount: 2 }), /身份正在使用/)
  releaseGate()
  const agent = await starting
  await assert.rejects(create(a.worldId), /身份正在使用/)
  await Promise.all([agent.dispose(), agent.dispose()])
  fail = true
  await assert.rejects(create(a.worldId), /模型装配失败/)
  fail = false
  const resumed = await create(a.worldId)
  assert.equal(await readFile(join(a.mainAgent.writableRoot, 'result.md'), 'utf8'), '保留成果')
  t.mock.method(resumed.context.agentLoop, 'dispose', async () => { throw new Error('清理失败') })
  await assert.rejects(resumed.dispose(), /清理失败/)
  await assert.rejects(create(a.worldId), /身份正在使用/)
})

test('父 Agent 销毁取消角色任务，保留已创建资料并释放身份和 Session', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'workspace-child-cancel-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const dir of ['main', 'character', 'confirmed', 'catalog']) await mkdir(join(readRoot, dir), { recursive: true })
  await mkdir(sessionRoot)
  const world: WorldWorkspaceConfig = { worldId: 'cancel-world', readRoot, confirmedRoot: join(readRoot, 'confirmed'),
    catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') },
    agents: [{ agentId: 'creator', writableRoot: join(readRoot, 'character') }] }
  class ParentAdapter extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate' as ToolCallId,
        name: 'delegate_character_creator', arguments: JSON.stringify({ task: '创建角色并等待' }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  class WaitingChild extends LlmAdapter {
    calls = 0
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (++this.calls === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'create' as ToolCallId, name: 'character_create',
          arguments: JSON.stringify({ character: { name: '已保存角色', summary: '建议', categories: {}, body: '内容' } }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        enter()
        await new Promise<void>((_resolve, reject) => {
          if (options.signal?.aborted) reject(options.signal.reason)
          else options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
      }
    }
  }
  const parentAdapter = new ParentAdapter(); const childAdapter = new WaitingChild()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: parentAdapter }))
  const child = { agentId: 'creator', sessionId: 'child-session', sessionMode: 'create' as const, sessionRoot,
    initializeCharacters: true, provider: 'test', model: 'test', adapter: childAdapter, defaultCharacterCount: 2 }
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, child, { singleWriterProcess: true })
  const running = parent.run({ prompt: '执行任务' })
  const rejected = assert.rejects(running)
  await entered
  await parent.dispose()
  await rejected
  const store = await CharacterStore.open(world.agents[0]!.writableRoot)
  try { assert.equal((await store.query({ name: '已保存角色' })).length, 1) } finally { await store.close() }
  const resumed = await createCharacterCreator({ ...child, worldId: world.worldId, readRoot, characterRoot: world.agents[0]!.writableRoot,
    sessionMode: 'resume', initializeCharacters: false, adapter: new FixedAdapter() })
  await resumed.dispose()
})
