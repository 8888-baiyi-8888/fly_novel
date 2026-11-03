import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { bootstrapAgents } from '../core/bootstrap.js'

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly fail = false) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.fail) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '模型不可用', code: 'PROVIDER_ERROR' } } }
      return
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '收到构想' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('通过内置 Preset 创建世界初始化主 Agent，装配提示词与 Skill 并隔离实例', async () => {
  const framework = await bootstrapAgents()
  const root = resolve('src/agents/world-initialization-main-agent/skills')
  const adapter = new Adapter()
  const config = {
    'agent-loop-runtime': { provider: 'test', model: 'test', workingDirectory: process.cwd() },
    'skill-filesystem': { root },
    llm: { adapters: [{ providers: ['test'], adapter }] },
  }
  try {
    const agent = await framework.manager.create({ id: 'world-main', presetId: 'world-initialization-main-agent', pluginConfigs: config })
    const another = await framework.manager.create({ id: 'world-main-2', presetId: 'world-initialization-main-agent', pluginConfigs: config })
    assert.equal(agent.info.identity.role, 'world-initialization-main')
    assert.ok(agent.context.systemPrompt.getSection('world-initialization:identity'))
    assert.ok(agent.context.tools.get('skill'))
    assert.notEqual(agent.context.skills, another.context.skills)
    assert.deepEqual(await agent.run({ prompt: '我想写玄幻故事' }), { content: '收到构想' })
    const request = JSON.stringify(adapter.requests[0])
    assert.match(request, /你是世界初始化主 Agent/)
    assert.match(request, /fantasy-world-planning/)
    assert.doesNotMatch(request, /玄幻世界初始化规划/)
    const skills = agent.context.skills
    await framework.manager.dispose('world-main')
    await assert.rejects(skills.list(process.cwd(), new AbortController().signal), /已关闭/)
    assert.equal((await another.context.skills.list(process.cwd(), new AbortController().signal))[0]?.name, 'fantasy-world-planning')
  } finally {
    await framework.manager.disposeAll()
  }
})

test('主 Agent 创建失败释放 ID，模型失败向调用方传播', async () => {
  const framework = await bootstrapAgents()
  const root = resolve('src/agents/world-initialization-main-agent/skills')
  const adapter = new Adapter(true)
  const config = {
    'agent-loop-runtime': { provider: 'test', model: 'test', workingDirectory: process.cwd() },
    'skill-filesystem': { root }, llm: { adapters: [{ providers: ['test'], adapter }] },
  }
  try {
    await assert.rejects(framework.manager.create({ id: 'failure', presetId: 'world-initialization-main-agent', pluginConfigs: {
      ...config, 'skill-filesystem': { root: 'relative-path' },
    } }), /绝对路径/)
    assert.equal(framework.manager.list().length, 0)
    const agent = await framework.manager.create({ id: 'failure', presetId: 'world-initialization-main-agent', pluginConfigs: config })
    await assert.rejects(agent.run({ prompt: '想法' }), /模型不可用/)
    assert.deepEqual(agent.context.sessions.list()[0]?.read().filter(event => event.type === 'turn/end').at(-1)?.data.reason,
      { kind: 'error', message: 'Turn 执行失败' })
  } finally {
    await framework.manager.disposeAll()
  }
})
