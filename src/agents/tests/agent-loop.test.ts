import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { AgentLoopRuntime } from '@fly-novel/agent-loop'
import type { AgentLoop } from '@fly-novel/agent-loop'
import { bootstrapAgents } from '@fly-novel/agents'
import type { AgentFramework } from '@fly-novel/agents'
import { loadConfiguredAdapter } from '../../app/call-llm.js'

class FixedResponseAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  failure: StreamChunk | undefined

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.failure) {
      yield this.failure
      return
    }
    const input = options.messages.at(-1)?.content[0]
    yield { type: 'block-start', index: 0, block: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: '固定推理' }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: '固定推理' } }
    yield { type: 'block-start', index: 1, block: 'text' }
    yield { type: 'text-delta', index: 1, text: input?.type === 'text' ? input.text : '' }
    yield { type: 'block-end', index: 1, block: { type: 'text', text: input?.type === 'text' ? input.text : '' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class AbortAwareAdapter extends LlmAdapter {
  private notifyStarted: () => void = () => undefined
  readonly started = new Promise<void>((resolve) => { this.notifyStarted = resolve })

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.notifyStarted()
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) {
        resolve()
        return
      }
      options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '请求已取消', code: 'ABORTED' } } }
  }
}

function registerRuntimePreset(framework: AgentFramework): void {
  framework.presets.register({
    id: 'runtime-test',
    version: '1',
    role: 'character',
    plugins: [
      { pluginId: 'agent-loop-runtime', config: { provider: 'test-provider', model: 'test-model' } },
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

  it('真实 Agent Loop 调用 DeepSeek 模型', async () => {
    const { provider, model, adapter } = await loadConfiguredAdapter('deepseek')
    framework = await bootstrapAgents()
    framework.presets.register({
      id: 'agent-loop-real-test',
      version: '1',
      role: 'character',
      plugins: [
        { pluginId: 'agent-loop-runtime', config: { provider, model } },
        { pluginId: 'system-prompt' },
        { pluginId: 'llm' },
        { pluginId: 'session' },
      ],
    })
    const agent = await framework.manager.create({
      id: 'agent-loop-real-test',
      presetId: 'agent-loop-real-test',
      pluginConfigs: { llm: { adapters: [{ providers: [provider], adapter }] } },
    })

    const result = await agent.run({ prompt: '请只用一句话说明什么是 Agent Loop。' })
    assert.ok(result.content.trim(), '真实模型应返回非空文本')
    const session = agent.context.sessions.list()[0]
    assert.ok(session)
    assert.deepEqual(session.read().filter((event) => event.type === 'turn/end')[0]?.data.reason, { kind: 'completed' })
    assert.deepEqual(session.deriveMessages().map(({ role }) => role), ['user', 'assistant'])
    console.log('Agent Loop 真实模型响应：', result.content)
  })

  it('从当前 Agent Context 获取 Session 并记录 Turn/Step 生命周期', async () => {
    framework = await bootstrapAgents()
    registerRuntimePreset(framework)

    const adapter = new FixedResponseAdapter()
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
    assert.equal(adapter.requests.length, 1)
    assert.equal(adapter.requests[0]?.provider, 'test-provider')
    assert.equal(adapter.requests[0]?.model, 'test-model')
    assert.equal(adapter.requests[0]?.messages.length, 1)
    assert.equal(adapter.requests[0]?.messages[0]?.role, 'user')
    assert.deepEqual(session.read().map(({ type }) => type), [
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    ])
    assert.deepEqual(session.deriveMessages().map(({ role, content }) => ({
      role,
      content: content.map(({ type }) => type),
    })), [
      { role: 'user', content: ['text'] },
      { role: 'assistant', content: ['reasoning', 'text'] },
    ])

    await framework.manager.dispose('runtime-agent')
    assert.equal(agent.context.get('agentLoop'), undefined)
    assert.equal(agent.context.get('systemPrompt'), undefined)
    assert.equal(agent.context.get('llm'), undefined)
    assert.throws(() => session.read(), /已关闭/)
    assert.throws(() => systemPrompt.assemble(), /已销毁/)
    assert.equal(adapter.requests.length, 1)
  })

  it('同一 Agent 连续运行时复用 Context 中的 Session', async () => {
    framework = await bootstrapAgents()
    registerRuntimePreset(framework)

    const adapter = new FixedResponseAdapter()
    const agent = await framework.manager.create({
      id: 'runtime-agent',
      presetId: 'runtime-test',
      pluginConfigs: { llm: { adapters: [{ providers: ['test-provider'], adapter }] } },
    })
    const sessions = agent.context.get('sessions')
    assert.ok(sessions)
    const session = sessions.list()[0]
    assert.ok(session)

    await Promise.all([
      agent.run({ prompt: '第一轮' }),
      agent.run({ prompt: '第二轮' }),
    ])

    assert.deepEqual(session.read()
      .filter((event) => event.type === 'turn/start')
      .map((event) => event.data.turn), [1, 2])
    assert.deepEqual(adapter.requests.map(({ messages }) => messages.map(({ role }) => role)), [
      ['user'],
      ['user', 'assistant', 'user'],
    ])
    assert.deepEqual(adapter.requests[1]?.messages.map(({ role, content }) => ({
      role,
      blocks: content.map(({ type }) => type),
    })), [
      { role: 'user', blocks: ['text'] },
      { role: 'assistant', blocks: ['reasoning', 'text'] },
      { role: 'user', blocks: ['text'] },
    ])
  })

  it('每轮组装最新 SystemPrompt 并将其作为唯一系统消息放在历史开头', async () => {
    framework = await bootstrapAgents()
    registerRuntimePreset(framework)
    const adapter = new FixedResponseAdapter()
    const agent = await framework.manager.create({
      id: 'runtime-prompt-agent',
      presetId: 'runtime-test',
      pluginConfigs: { llm: { adapters: [{ providers: ['test-provider'], adapter }] } },
    })
    let instruction = '第一版系统提示'
    agent.context.systemPrompt.section({ name: 'identity', order: 0, text: () => instruction })

    await agent.run({ prompt: '第一轮' })
    instruction = '第二版系统提示'
    await agent.run({ prompt: '第二轮' })

    assert.deepEqual(adapter.requests.map(({ messages }) => messages.map(({ role }) => role)), [
      ['system', 'user'],
      ['system', 'user', 'assistant', 'user'],
    ])
    assert.deepEqual(adapter.requests.map(({ messages }) => messages[0]?.content), [
      [{ type: 'text', text: '第一版系统提示' }],
      [{ type: 'text', text: '第二版系统提示' }],
    ])

    const session = agent.context.sessions.list()[0]
    assert.ok(session)
    assert.deepEqual(session.read().filter(({ type }) => type === 'system/message').length, 2)
    assert.deepEqual(session.deriveMessages().map(({ role, content }) => ({
      role,
      text: content.flatMap((block) => block.type === 'text' ? [block.text] : []).join(''),
    })), [
      { role: 'system', text: '第二版系统提示' },
      { role: 'user', text: '第一轮' },
      { role: 'assistant', text: '第一轮' },
      { role: 'user', text: '第二轮' },
      { role: 'assistant', text: '第二轮' },
    ])
  })

  it('Session 按 Agent Context 隔离并随 Agent 销毁', async () => {
    framework = await bootstrapAgents()
    registerRuntimePreset(framework)

    const first = await framework.manager.create({
      id: 'runtime-first',
      presetId: 'runtime-test',
      pluginConfigs: { llm: { adapters: [{ providers: ['test-provider'], adapter: new FixedResponseAdapter() }] } },
    })
    const second = await framework.manager.create({
      id: 'runtime-second',
      presetId: 'runtime-test',
      pluginConfigs: { llm: { adapters: [{ providers: ['test-provider'], adapter: new FixedResponseAdapter() }] } },
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

    const adapter = new FixedResponseAdapter()
    const runtimeAgent = await framework.manager.create({
      id: 'runtime-agent',
      presetId: 'runtime-test',
      pluginConfigs: { llm: { adapters: [{ providers: ['test-provider'], adapter }] } },
    })
    const mockAgent = await framework.manager.create({ id: 'mock-agent', presetId: 'mock-test' })

    assert.ok(runtimeAgent.context.get('agentLoop') instanceof AgentLoopRuntime)
    assert.deepEqual(await runtimeAgent.run({ prompt: '真实 Loop' }), { content: '真实 Loop' })
    assert.deepEqual(await mockAgent.run({ prompt: 'Mock Loop' }), { content: '[Mock] Mock Loop' })
    assert.equal(adapter.requests.length, 1)
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
        cancel() {},
        async dispose() {},
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

  it('LLM 失败时结束 Turn 并向调用方传播 LlmError', async () => {
    framework = await bootstrapAgents()
    registerRuntimePreset(framework)
    const adapter = new FixedResponseAdapter()
    adapter.failure = { type: 'finish', reason: { kind: 'error', failure: { message: '模型不可用', code: 'PROVIDER_ERROR' } } }
    const agent = await framework.manager.create({
      id: 'runtime-failure-agent',
      presetId: 'runtime-test',
      pluginConfigs: { llm: { adapters: [{ providers: ['test-provider'], adapter }] } },
    })

    await assert.rejects(agent.run({ prompt: '测试失败' }), (error) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'PROVIDER_ERROR')
      return true
    })
    const session = agent.context.sessions.list()[0]
    assert.ok(session)
    assert.deepEqual(session.read().map(({ type }) => type), [
      'turn/start', 'step/start', 'user/message', 'step/end', 'turn/end',
    ])
    assert.deepEqual(session.deriveMessages().map(({ role }) => role), ['user'])
    assert.deepEqual(session.read().filter((event) => event.type === 'turn/end')[0]?.data.reason,
      { kind: 'error', message: 'Turn 执行失败' })
  })

  it('cancel 中止活动模型请求并拒绝尚未开始的排队 Turn', async () => {
    framework = await bootstrapAgents()
    registerRuntimePreset(framework)
    const adapter = new AbortAwareAdapter()
    const agent = await framework.manager.create({
      id: 'runtime-cancel-agent',
      presetId: 'runtime-test',
      pluginConfigs: { llm: { adapters: [{ providers: ['test-provider'], adapter }] } },
    })
    const active = agent.run({ prompt: '正在运行' })
    await adapter.started
    const queued = agent.run({ prompt: '排队中' })

    agent.cancel()

    await assert.rejects(active, (error) => error instanceof LlmError && error.code === 'ABORTED')
    await assert.rejects(queued, (error) => error instanceof LlmError && error.code === 'ABORTED')
    const session = agent.context.sessions.list()[0]
    assert.ok(session)
    assert.deepEqual(session.read().flatMap((event) => event.type === 'turn/end' ? [event.data.reason] : []), [
      { kind: 'aborted', reason: 'user' },
    ])
    assert.deepEqual(session.deriveMessages().map(({ role }) => role), ['user'])
  })

  it('销毁 Agent 时取消活动请求、拒绝排队 Turn 并等待 Loop 收尾', async () => {
    framework = await bootstrapAgents()
    registerRuntimePreset(framework)
    const adapter = new AbortAwareAdapter()
    const agent = await framework.manager.create({
      id: 'runtime-dispose-agent',
      presetId: 'runtime-test',
      pluginConfigs: { llm: { adapters: [{ providers: ['test-provider'], adapter }] } },
    })
    const active = agent.run({ prompt: '正在运行' })
    await adapter.started
    const queued = agent.run({ prompt: '排队中' })

    await framework.manager.dispose('runtime-dispose-agent')

    await assert.rejects(active, (error) => error instanceof LlmError && error.code === 'ABORTED')
    await assert.rejects(queued, (error) => error instanceof LlmError && error.code === 'ABORTED')
    assert.equal(agent.state, 'disposed')
  })

  it('Agent.run 原样传播 Loop 的失败', async () => {
    framework = await bootstrapAgents()
    const expectedError = new Error('Turn 执行失败')
    const loop = Object.assign((ctx: Context) => {
      const agentLoop: AgentLoop = {
        async run() {
          throw expectedError
        },
        cancel() {},
        async dispose() {},
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
