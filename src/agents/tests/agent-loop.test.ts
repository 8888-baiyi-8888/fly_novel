import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type StreamChunk } from '@fly-novel/llm'
import { AgentLoopRuntime } from '@fly-novel/agent-loop'
import type { AgentLoop } from '@fly-novel/agent-loop'
import { bootstrapAgents } from '@fly-novel/agents'
import type { AgentFramework } from '@fly-novel/agents'

class NoRequestAdapter extends LlmAdapter {
  requests = 0

  override async *stream(): AsyncIterable<StreamChunk> {
    this.requests += 1
    throw new Error('此测试不应发起模型请求')
  }
}

function registerRuntimePreset(framework: AgentFramework): void {
  framework.presets.register({
    id: 'runtime-test',
    version: '1',
    role: 'character',
    plugins: [
      { pluginId: 'agent-loop-runtime' },
      { pluginId: 'system-prompt' },
      { pluginId: 'llm' },
      { pluginId: 'session' },
    ],
  })
}

describe('AgentLoop Runtime', () => {
  let framework: AgentFramework | undefined

  afterEach(async () => {
    await framework?.manager.disposeAll()
    framework = undefined
  })

  it('从当前 Agent Context 获取 Session 并记录 Turn/Step 生命周期', async () => {
    framework = await bootstrapAgents()
    registerRuntimePreset(framework)

    const adapter = new NoRequestAdapter()
    const agent = await framework.manager.create({
      id: 'runtime-agent',
      presetId: 'runtime-test',
      pluginConfigs: { llm: { adapters: [{ providers: ['test-provider'], adapter }] } },
    })
    const sessions = agent.context.get('sessions')
    const systemPrompt = agent.context.get('systemPrompt')
    const llm = agent.context.get('llm')
    const loop = agent.context.get('agentLoop')
    assert.ok(sessions)
    assert.ok(systemPrompt)
    assert.ok(llm)
    assert.ok(loop)
    assert.ok(loop instanceof AgentLoopRuntime)
    assert.equal(sessions.list().length, 1)
    const session = sessions.list()[0]
    assert.ok(session)

    assert.deepEqual(await agent.run({ prompt: '继续这一幕' }), { content: '继续这一幕' })
    assert.equal(adapter.requests, 0)
    assert.deepEqual(session.read().map(({ type, data }) => ({ type, data })), [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ])

    await framework.manager.dispose('runtime-agent')
    assert.equal(agent.context.get('agentLoop'), undefined)
    assert.equal(agent.context.get('systemPrompt'), undefined)
    assert.equal(agent.context.get('llm'), undefined)
    assert.throws(() => session.read(), /已关闭/)
    assert.throws(() => systemPrompt.assemble(), /已销毁/)
    assert.equal(adapter.requests, 0)
  })

  it('同一 Agent 连续运行时复用 Context 中的 Session', async () => {
    framework = await bootstrapAgents()
    registerRuntimePreset(framework)

    const agent = await framework.manager.create({
      id: 'runtime-agent',
      presetId: 'runtime-test',
      pluginConfigs: { llm: { adapters: [{ providers: ['test-provider'], adapter: new NoRequestAdapter() }] } },
    })
    const sessions = agent.context.get('sessions')
    assert.ok(sessions)
    const session = sessions.list()[0]
    assert.ok(session)

    await agent.run({ prompt: '第一轮' })
    await agent.run({ prompt: '第二轮' })

    assert.deepEqual(session.read()
      .filter((event) => event.type === 'turn/start')
      .map((event) => event.data.turn), [1, 2])
  })

  it('Session 按 Agent Context 隔离并随 Agent 销毁', async () => {
    framework = await bootstrapAgents()
    registerRuntimePreset(framework)

    const first = await framework.manager.create({
      id: 'runtime-first',
      presetId: 'runtime-test',
      pluginConfigs: { llm: { adapters: [{ providers: ['test-provider'], adapter: new NoRequestAdapter() }] } },
    })
    const second = await framework.manager.create({
      id: 'runtime-second',
      presetId: 'runtime-test',
      pluginConfigs: { llm: { adapters: [{ providers: ['test-provider'], adapter: new NoRequestAdapter() }] } },
    })
    const firstSession = first.context.sessions.list()[0]
    const secondSession = second.context.sessions.list()[0]
    assert.ok(firstSession)
    assert.ok(secondSession)
    assert.notEqual(firstSession, secondSession)

    await framework.manager.dispose(first.info.identity.id)
    assert.throws(() => firstSession.read(), /已关闭/)
    assert.deepEqual(await second.run({ prompt: '第二个 Agent 仍可运行' }), { content: '第二个 Agent 仍可运行' })
  })

  it('Preset 可选择真实 Loop 或 mock loop', async () => {
    framework = await bootstrapAgents()
    registerRuntimePreset(framework)
    framework.presets.register({
      id: 'mock-test',
      version: '1',
      role: 'character',
      plugins: [{ pluginId: 'mock-loop', config: { prefix: '[Mock]' } }],
    })

    const adapter = new NoRequestAdapter()
    const runtimeAgent = await framework.manager.create({
      id: 'runtime-agent',
      presetId: 'runtime-test',
      pluginConfigs: { llm: { adapters: [{ providers: ['test-provider'], adapter }] } },
    })
    const mockAgent = await framework.manager.create({ id: 'mock-agent', presetId: 'mock-test' })

    assert.ok(runtimeAgent.context.get('agentLoop') instanceof AgentLoopRuntime)
    assert.deepEqual(await runtimeAgent.run({ prompt: '真实 Loop' }), { content: '真实 Loop' })
    assert.deepEqual(await mockAgent.run({ prompt: 'Mock Loop' }), { content: '[Mock] Mock Loop' })
    assert.equal(adapter.requests, 0)
  })

  it('Agent.run 将输入交给装配的 Loop 并返回其结果', async () => {
    framework = await bootstrapAgents()
    let receivedPrompt: string | undefined
    const loop = Object.assign((ctx: Context) => {
      const agentLoop: AgentLoop = {
        async run(input) {
          receivedPrompt = input.prompt
          return { content: '完成的助手回复' }
        },
      }
      ctx.provide('agentLoop', agentLoop)
    }, { provide: 'agentLoop' })
    framework.plugins.register({ id: 'contract-loop', version: '1', plugin: loop })
    framework.presets.register({
      id: 'contract-loop', version: '1', role: 'character',
      plugins: [{ pluginId: 'contract-loop' }],
    })

    const agent = await framework.manager.create({ id: 'contract-agent', presetId: 'contract-loop' })
    assert.deepEqual(await agent.run({ prompt: '继续这一幕' }), { content: '完成的助手回复' })
    assert.equal(receivedPrompt, '继续这一幕')
  })

  it('Agent.run 原样传播 Loop 的失败', async () => {
    framework = await bootstrapAgents()
    const expectedError = new Error('Turn 执行失败')
    const loop = Object.assign((ctx: Context) => {
      const agentLoop: AgentLoop = {
        async run() {
          throw expectedError
        },
      }
      ctx.provide('agentLoop', agentLoop)
    }, { provide: 'agentLoop' })
    framework.plugins.register({ id: 'failing-loop', version: '1', plugin: loop })
    framework.presets.register({
      id: 'failing-loop', version: '1', role: 'character',
      plugins: [{ pluginId: 'failing-loop' }],
    })

    const agent = await framework.manager.create({ id: 'failing-agent', presetId: 'failing-loop' })
    await assert.rejects(agent.run({ prompt: '继续这一幕' }), (error) => error === expectedError)
  })
})
