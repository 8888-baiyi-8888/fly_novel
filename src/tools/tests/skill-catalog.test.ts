import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { bootstrapAgents } from '../../agents/core/bootstrap.js'

class CaptureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function content(request: GenerateOptions): string {
  return JSON.stringify(request.messages)
}

test('模型只看到本实例的可调用摘要，目录变化和空目录会替换旧内容', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'fly-skill-catalog-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const rootA = join(base, 'a')
  const rootB = join(base, 'b')
  await mkdir(join(rootA, 'alpha'), { recursive: true })
  await mkdir(join(rootA, 'hidden'))
  await mkdir(join(rootB, 'beta'), { recursive: true })
  await writeFile(join(rootA, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 规划世界\n---\n机密正文甲')
  await writeFile(join(rootA, 'hidden', 'SKILL.md'), '---\nname: hidden\ndescription: 禁止模型调用\ndisable-model-invocation: true\n---\n隐藏正文')
  await writeFile(join(rootB, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: 规划角色\n---\n机密正文乙')
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.presets.register({ id: 'catalog-test', version: '1', role: 'character', plugins: [
    { pluginId: 'agent-loop-runtime' }, { pluginId: 'session' }, { pluginId: 'system-prompt' },
    { pluginId: 'llm' }, { pluginId: 'tools' }, { pluginId: 'skills' },
    { pluginId: 'skill-filesystem' }, { pluginId: 'tool-skill' },
  ] })
  const create = async (id: string, root: string, adapter: CaptureAdapter) => framework.manager.create({
    id, presetId: 'catalog-test', pluginConfigs: {
      'agent-loop-runtime': { provider: 'test', model: 'test', workingDirectory: base },
      'skill-filesystem': { root }, llm: { adapters: [{ providers: ['test'], adapter }] },
    },
  })
  const adapterA = new CaptureAdapter()
  const adapterB = new CaptureAdapter()
  const first = await create('a', rootA, adapterA)
  const second = await create('b', rootB, adapterB)
  await first.run({ prompt: '开始' })
  await second.run({ prompt: '开始' })
  const initialA = content(adapterA.requests[0]!)
  const initialB = content(adapterB.requests[0]!)
  assert.match(initialA, /<available_skills>/)
  assert.match(initialA, /alpha.*规划世界/)
  assert.doesNotMatch(initialA, /beta|规划角色|机密正文|hidden|隐藏正文/)
  assert.match(initialB, /beta.*规划角色/)
  assert.doesNotMatch(initialB, /alpha|规划世界|机密正文/)
  await writeFile(join(rootA, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 更新用途\n---\n机密正文甲')
  await first.run({ prompt: '继续' })
  assert.match(content(adapterA.requests[1]!), /更新用途/)
  assert.doesNotMatch(content(adapterA.requests[1]!), /规划世界/)
  await rm(join(rootA, 'alpha'), { recursive: true })
  await first.run({ prompt: '继续' })
  assert.doesNotMatch(content(adapterA.requests[2]!), /available_skills|alpha|更新用途/)
})

test('来源发现失败时不发送模型请求，修复后可重试', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fly-skill-catalog-error-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'invalid'))
  await writeFile(join(root, 'invalid', 'SKILL.md'), '无效内容')
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.presets.register({ id: 'catalog-error', version: '1', role: 'character', plugins: [
    { pluginId: 'agent-loop-runtime' }, { pluginId: 'session' }, { pluginId: 'system-prompt' },
    { pluginId: 'llm' }, { pluginId: 'tools' }, { pluginId: 'skills' },
    { pluginId: 'skill-filesystem' }, { pluginId: 'tool-skill' },
  ] })
  const adapter = new CaptureAdapter()
  const agent = await framework.manager.create({ id: 'error', presetId: 'catalog-error', pluginConfigs: {
    'agent-loop-runtime': { provider: 'test', model: 'test', workingDirectory: root },
    'skill-filesystem': { root }, llm: { adapters: [{ providers: ['test'], adapter }] },
  } })
  await assert.rejects(agent.run({ prompt: '开始' }), /frontmatter/)
  assert.equal(adapter.requests.length, 0)
  await writeFile(join(root, 'invalid', 'SKILL.md'), '---\nname: invalid\ndescription: 已修复\n---\n正文')
  await agent.run({ prompt: '重试' })
  assert.match(content(adapter.requests[0]!), /invalid.*已修复/)
})
