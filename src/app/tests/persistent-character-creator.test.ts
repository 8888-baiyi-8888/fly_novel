import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { createPersistentAgentCreator } from '@fly-novel/subagent-persistent-in-process'
import { bootstrapAgents } from '../../agents/core/bootstrap.js'
import { createTestAgent, withAgentLoop } from '../../agents/tests/agent-loop-fixtures.js'
import { createCharacterCreator } from '../agents/character-creator.js'

class CaptureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '角色建议' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('persistent 使用角色创建 Agent 自己的会话继续委派', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'persistent-character-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const characterRoot = join(readRoot, 'characters'); const sessionRoot = join(root, 'sessions')
  await mkdir(readRoot); await mkdir(characterRoot); await mkdir(sessionRoot)
  const adapter = new CaptureAdapter()
  const create = createPersistentAgentCreator({ presetId: 'character-creator', sessionMode: 'create', async create({ sessionMode, initial }) {
    const agent = await createCharacterCreator({ worldId: 'world', agentId: 'creator', sessionId: 'session', sessionMode,
      sessionRoot, characterRoot, initializeCharacters: initial, readRoot, provider: 'child', model: 'test', adapter, defaultCharacterCount: 3 })
    return { agent, dispose: () => agent.dispose() }
  } })
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.presets.register({ id: 'persistent-parent-real', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-persistent-in-process' },
  ]) })
  const parent = await createTestAgent(framework, { id: 'parent', presetId: 'persistent-parent-real', pluginConfigs: { 'subagent-persistent-in-process': { create } } })
  await parent.run({ prompt: '仅父会话内容' })
  const input = { parent, presetId: 'character-creator', signal: new AbortController().signal }
  const first = await parent.context.subagents.start('persistent', { ...input, prompt: '创建调查者' })
  assert.deepEqual(await first.result, { output: '角色建议', stopReason: 'completed' })
  await first.dispose()
  const second = await parent.context.subagents.start('persistent', { ...input, prompt: '完善调查者' })
  assert.deepEqual(await second.result, { output: '角色建议', stopReason: 'completed' })
  await second.dispose()
  const history = JSON.stringify(adapter.requests[1]?.messages)
  assert.match(history, /创建调查者/)
  assert.match(history, /完善调查者/)
  assert.doesNotMatch(history, /仅父会话内容/)
})
