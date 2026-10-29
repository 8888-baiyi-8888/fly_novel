import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type MessageId, type StreamChunk } from '@fly-novel/llm'
import { loadConfiguredAdapter } from '../../app/call-llm.js'
import { bootstrapAgents } from '../core/bootstrap.js'
import type { AgentFramework } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

declare module '@deepseek-ai/cordis' {
  interface Context { harnessStageA: object; harnessStageB: object }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('Cordis Agent Harness', () => {
  let framework: AgentFramework | undefined

  afterEach(async () => {
    await framework?.manager.disposeAll()
    framework = undefined
  })

  it('通过外部注册的 Preset 装配角色和导演 Agent', async () => {
    framework = await bootstrapAgents()
    assert.deepEqual(framework.plugins.list().map((plugin) => plugin.id), ['agent-loop-runtime', 'mock-memory', 'llm', 'session', 'system-prompt', 'tools', 'character-example-memory', 'character-system-prompt', 'director-system-prompt'])
    assert.deepEqual(framework.presets.list().map((preset) => preset.id), ['character-agent', 'director-agent'])

    const character = await createTestAgent(framework, {
      id: 'character-001',
      presetId: 'character-agent',
      parameters: { novelId: 'novel-001', temperature: 0.8 },
    })
    const director = await createTestAgent(framework, {
      id: 'director-001',
      presetId: 'director-agent',
    })

    assert.equal(character.state, 'ready')
    assert.equal(character.info.identity.role, 'character')
    assert.equal(character.info.parameters.novelId, 'novel-001')
    assert.equal(character.info.parameters.temperature, 0.8)
    assert.equal(director.info.identity.role, 'director')
    assert.ok(character.context.get('llm'))
    assert.ok(director.context.get('llm'))

    assert.deepEqual(await character.run({ prompt: '你好' }), { content: '你好' })
    assert.deepEqual(await director.run({ prompt: '你好' }), { content: '你好' })
  })

  it('LLM 插件由 Preset 选择，实例路由隔离并随 Agent 销毁', async () => {
    class Adapter extends LlmAdapter {
      override async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    framework = await bootstrapAgents()
    framework.presets.register({
      id: 'llm-debug', version: '1', role: 'character',
      plugins: withAgentLoop([]),
    })

    const first = await createTestAgent(framework, {
      id: 'first', presetId: 'llm-debug',
      pluginConfigs: { llm: { adapters: [{ providers: ['first'], adapter: new Adapter() }] } },
    })
    const second = await createTestAgent(framework, {
      id: 'second', presetId: 'llm-debug',
      pluginConfigs: { llm: { adapters: [{ providers: ['second'], adapter: new Adapter() }] } },
    })
    const firstLlm = first.context.get('llm')
    const secondLlm = second.context.get('llm')
    assert.ok(firstLlm)
    assert.ok(secondLlm)
    assert.notEqual(firstLlm, secondLlm)
    assert.equal(framework.context.get('llm'), undefined)

    const firstRequest: GenerateOptions = { provider: 'first', model: 'model', messages: [] }
    const secondRequest: GenerateOptions = { provider: 'second', model: 'model', messages: [] }
    const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
    assert.deepEqual(await collect(firstLlm.stream(firstRequest)), [finish])
    assert.deepEqual(await collect(secondLlm.stream(secondRequest)), [finish])
    const missing = await collect(firstLlm.stream(secondRequest))
    assert.ok(missing[0]?.type === 'finish' && missing[0].reason.kind === 'error')
    assert.equal(missing[0].reason.failure.code, 'NO_ADAPTER')

    await framework.manager.dispose('first')
    assert.equal(first.context.get('llm'), undefined)
    const removed = await collect(firstLlm.stream(firstRequest))
    assert.ok(removed[0]?.type === 'finish' && removed[0].reason.kind === 'error')
    assert.equal(removed[0].reason.failure.code, 'NO_ADAPTER')
    assert.deepEqual(await collect(secondLlm.stream(secondRequest)), [finish])
  })

  it('LLM 插件调用真实模型', { skip: process.env.FLY_NOVEL_REAL_LLM_TEST !== '1' }, async () => {
    const { provider, model, adapter } = await loadConfiguredAdapter('deepseek')
    framework = await bootstrapAgents()
    framework.presets.register({
      id: 'llm-real', version: '1', role: 'character',
      plugins: withAgentLoop([]),
    })
    const agent = await createTestAgent(framework, {
      id: 'llm-real', presetId: 'llm-real',
      pluginConfigs: { llm: { adapters: [{ providers: [provider], adapter }] } },
    })
    const llm = agent.context.get('llm')
    assert.ok(llm)
    const chunks = await collect(llm.stream({
      provider, model,
      messages: [{
        id: 'llm-real-test' as MessageId,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '请只回答：今天日期' }],
      }],
    }))
    const response = chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' ? [chunk.block.text] : []).join('')
    const finish = chunks.find(chunk => chunk.type === 'finish')
    assert.ok(finish?.type === 'finish')
    assert.equal(finish.reason.kind, 'stop')
    assert.ok(response.trim(), '模型应返回非空文本')
    console.log('LLM 插件真实响应：', response)
  })

  it('LLM 插件拒绝空配置和无效路由，失败后 Agent ID 可重新创建', async () => {
    class Adapter extends LlmAdapter {
      override async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    class BadAdapter extends Adapter {
      override providerInfo() {
        return { id: 'wrong', name: '错误供应商' }
      }
    }
    framework = await bootstrapAgents()
    framework.presets.register({
      id: 'llm-debug', version: '1', role: 'character',
      plugins: withAgentLoop([]),
    })
    await assert.rejects(
      createTestAgent(framework, { id: 'retry', presetId: 'llm-debug', pluginConfigs: { llm: { adapters: [] } } }),
      /至少一个适配器配置/,
    )
    await assert.rejects(
      createTestAgent(framework, {
        id: 'retry', presetId: 'llm-debug',
        pluginConfigs: { llm: { adapters: [
          { providers: ['first'], adapter: new Adapter() },
          { providers: ['second'], adapter: new BadAdapter() },
        ] } },
      }),
      /无效的供应商信息/,
    )
    assert.equal(framework.manager.list().length, 0)
    assert.equal(framework.context.get('llm'), undefined)
    const agent = await createTestAgent(framework, {
      id: 'retry', presetId: 'llm-debug',
      pluginConfigs: { llm: { adapters: [{ providers: ['first'], adapter: new Adapter() }] } },
    })
    assert.ok(agent.context.get('llm'))
  })

  it('每个 Agent 的插件服务和状态独立，销毁后服务被移除', async () => {
    framework = await bootstrapAgents()
    const first = await createTestAgent(framework, { id: 'first', presetId: 'character-agent' })
    const second = await createTestAgent(framework, { id: 'second', presetId: 'character-agent' })
    const firstMemory = first.context.get('memory')
    const secondMemory = second.context.get('memory')
    assert.ok(firstMemory)
    assert.ok(secondMemory)
    firstMemory.set('secret', 'first-only')
    assert.equal(secondMemory.get('secret'), undefined)
    assert.equal(framework.context.get('memory'), undefined)

    await framework.manager.dispose('first')
    assert.equal(first.state, 'disposed')
    assert.equal(first.context.get('memory'), undefined)
    assert.equal(first.context.get('agentLoop'), undefined)
    await assert.rejects(first.run({ prompt: '你好' }), /尚未就绪/)
    assert.equal(second.context.get('memory')?.get('secret'), undefined)
    assert.equal(framework.manager.list().length, 1)
    assert.throws(() => framework!.manager.get('first'), /不存在/)
  })

  it('初始化失败时清理已启动插件并释放 Agent ID', async () => {
    framework = await bootstrapAgents()
    let cleaned = false
    framework.plugins.register({
      id: 'cleanup-marker', version: '1', plugin: () => () => { cleaned = true },
    })
    framework.plugins.register({
      id: 'broken-plugin', version: '1', plugin: () => { throw new Error('启动失败') },
    })
    framework.presets.register({
      id: 'broken-preset', version: '1', role: 'character',
      plugins: withAgentLoop([{ pluginId: 'cleanup-marker' }, { pluginId: 'broken-plugin' }]),
    })

    await assert.rejects(
      createTestAgent(framework, { id: 'broken', presetId: 'broken-preset' }),
      /启动失败/,
    )
    assert.equal(cleaned, true)
    assert.equal(framework.manager.list().length, 0)
    const next = await createTestAgent(framework, { id: 'broken', presetId: 'character-agent' })
    assert.equal(next.state, 'ready')
  })

  it('Cordis 按 inject 声明等待后装配的服务插件', async () => {
    framework = await bootstrapAgents()
    let started = false
    const consumer = Object.assign((ctx: Context) => {
      started = ctx.get('memory') !== undefined
    }, { inject: ['memory'] })
    framework.plugins.register({ id: 'consumer', version: '1', plugin: consumer })
    framework.presets.register({
      id: 'injected', version: '1', role: 'character',
      plugins: withAgentLoop([{ pluginId: 'consumer' }, { pluginId: 'mock-memory' }]),
    })

    const agent = await createTestAgent(framework, { id: 'injected', presetId: 'injected' })
    assert.equal(agent.state, 'ready')
    assert.equal(started, true)
  })

  it('链式依赖的插件启动失败时清理并拒绝创建 Agent', async () => {
    framework = await bootstrapAgents()
    const last = Object.assign(() => { throw new Error('链式启动失败') }, { inject: ['harnessStageB'] })
    const middle = Object.assign((ctx: Context) => { ctx.provide('harnessStageB', {}) },
      { inject: ['harnessStageA'], provide: 'harnessStageB' })
    const first = Object.assign((ctx: Context) => { ctx.provide('harnessStageA', {}) }, { provide: 'harnessStageA' })
    framework.plugins.register({ id: 'chain-last', version: '1', plugin: last })
    framework.plugins.register({ id: 'chain-middle', version: '1', plugin: middle })
    framework.plugins.register({ id: 'chain-first', version: '1', plugin: first })
    framework.presets.register({ id: 'chain', version: '1', role: 'character', plugins: withAgentLoop([
      { pluginId: 'chain-last' }, { pluginId: 'chain-middle' }, { pluginId: 'chain-first' },
    ]) })
    await assert.rejects(createTestAgent(framework, { id: 'chain', presetId: 'chain' }), /链式启动失败/)
    assert.equal(framework.manager.list().length, 0)
  })

  it('插件依赖缺失时拒绝创建 Agent', async () => {
    framework = await bootstrapAgents()
    const consumer = Object.assign(() => undefined, { inject: ['harnessStageA'] })
    framework.plugins.register({ id: 'missing-dependency', version: '1', plugin: consumer })
    framework.presets.register({ id: 'missing-dependency', version: '1', role: 'character',
      plugins: withAgentLoop([{ pluginId: 'missing-dependency' }]) })
    await assert.rejects(createTestAgent(framework, { id: 'missing', presetId: 'missing-dependency' }), /插件依赖未就绪/)
    assert.equal(framework.manager.list().length, 0)
  })

  it('拒绝缺少 loop 的 Preset、重复注册和并发创建同名 Agent', async () => {
    framework = await bootstrapAgents()
    assert.throws(() => framework!.plugins.register({
      id: 'agent-loop-runtime', version: '1', plugin: () => undefined,
    }), /已注册/)
    assert.throws(() => framework!.plugins.get('missing-plugin'), /尚未注册/)
    framework.presets.register({
      id: 'no-loop', version: '1', role: 'character',
      plugins: [{ pluginId: 'mock-memory' }],
    })
    await assert.rejects(
      framework.manager.create({ id: 'no-loop', presetId: 'no-loop' }),
      /缺少 agentLoop 插件/,
    )

    const first = createTestAgent(framework, { id: 'same', presetId: 'character-agent' })
    await assert.rejects(createTestAgent(framework, { id: 'same', presetId: 'character-agent' }), /已存在/)
    await first
  })

  it('清理 Manager 会等待正在初始化的 Agent 并销毁它', async () => {
    framework = await bootstrapAgents()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    framework.plugins.register({
      id: 'delayed', version: '1', plugin: async () => { await gate },
    })
    framework.presets.register({
      id: 'delayed-preset', version: '1', role: 'character',
      plugins: withAgentLoop([{ pluginId: 'delayed' }]),
    })

    const creating = createTestAgent(framework, { id: 'pending', presetId: 'delayed-preset' })
    const disposing = framework.manager.disposeAll()
    release()
    const agent = await creating
    await disposing
    assert.equal(agent.state, 'disposed')
    assert.equal(framework.manager.list().length, 0)
  })
})
