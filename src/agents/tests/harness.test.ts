import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { bootstrapAgents } from '../core/bootstrap.js'
import type { AgentFramework } from '../core/bootstrap.js'

describe('Cordis Agent Harness', () => {
  let framework: AgentFramework | undefined

  afterEach(async () => {
    await framework?.manager.disposeAll()
    framework = undefined
  })

  it('通过外部注册的 Preset 装配角色和导演 Agent', async () => {
    framework = await bootstrapAgents()
    assert.deepEqual(framework.plugins.list().map((plugin) => plugin.id), ['mock-loop', 'mock-memory'])
    assert.deepEqual(framework.presets.list().map((preset) => preset.id), ['character-agent', 'director-agent'])

    const character = await framework.manager.create({
      id: 'character-001',
      presetId: 'character-agent',
      parameters: { novelId: 'novel-001', temperature: 0.8 },
    })
    const director = await framework.manager.create({
      id: 'director-001',
      presetId: 'director-agent',
    })

    assert.equal(character.state, 'ready')
    assert.equal(character.info.identity.role, 'character')
    assert.equal(character.info.parameters.novelId, 'novel-001')
    assert.equal(character.info.parameters.temperature, 0.8)
    assert.equal(director.info.identity.role, 'director')

    assert.deepEqual(await character.run({ prompt: '你好' }), { content: '[角色 Agent] 你好' })
    assert.deepEqual(await director.run({ prompt: '你好' }), { content: '[导演 Agent] 你好' })
  })

  it('每个 Agent 的插件服务和状态独立，销毁后服务被移除', async () => {
    framework = await bootstrapAgents()
    const first = await framework.manager.create({ id: 'first', presetId: 'character-agent' })
    const second = await framework.manager.create({ id: 'second', presetId: 'character-agent' })
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
      plugins: [{ pluginId: 'mock-loop' }, { pluginId: 'cleanup-marker' }, { pluginId: 'broken-plugin' }],
    })

    await assert.rejects(
      framework.manager.create({ id: 'broken', presetId: 'broken-preset' }),
      /启动失败/,
    )
    assert.equal(cleaned, true)
    assert.equal(framework.manager.list().length, 0)
    const next = await framework.manager.create({ id: 'broken', presetId: 'character-agent' })
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
      plugins: [{ pluginId: 'mock-loop' }, { pluginId: 'consumer' }, { pluginId: 'mock-memory' }],
    })

    const agent = await framework.manager.create({ id: 'injected', presetId: 'injected' })
    assert.equal(agent.state, 'ready')
    assert.equal(started, true)
  })

  it('拒绝缺少 loop 的 Preset、重复注册和并发创建同名 Agent', async () => {
    framework = await bootstrapAgents()
    assert.throws(() => framework!.plugins.register({
      id: 'mock-loop', version: '1', plugin: () => undefined,
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

    const first = framework.manager.create({ id: 'same', presetId: 'character-agent' })
    await assert.rejects(framework.manager.create({ id: 'same', presetId: 'character-agent' }), /已存在/)
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
      plugins: [{ pluginId: 'mock-loop' }, { pluginId: 'delayed' }],
    })

    const creating = framework.manager.create({ id: 'pending', presetId: 'delayed-preset' })
    const disposing = framework.manager.disposeAll()
    release()
    const agent = await creating
    await disposing
    assert.equal(agent.state, 'disposed')
    assert.equal(framework.manager.list().length, 0)
  })
})
