import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { bootstrapAgents } from '../core/bootstrap.js'
import type { AgentFramework } from '../core/bootstrap.js'
import { Session } from '@fly-novel/session'

describe('Session 基础类', () => {
  it('按追加顺序保存事件快照，并支持游标读取', () => {
    const session = new Session({ id: 'session-1', createdAt: new Date('2026-01-01T00:00:00.000Z') })
    const firstEvent = { type: 'user-input', text: '第一句' }

    assert.equal(session.append(firstEvent), 0)
    assert.equal(session.append({ type: 'assistant-output', text: '回应' }), 1)
    firstEvent.text = '调用方修改后的内容'

    assert.equal(session.id, 'session-1')
    assert.equal(session.size, 2)
    assert.deepEqual(session.read(), [
      { type: 'user-input', text: '第一句' },
      { type: 'assistant-output', text: '回应' },
    ])
    assert.deepEqual(session.read({ afterIndex: 0, limit: 1 }), [
      { type: 'assistant-output', text: '回应' },
    ])
    assert.deepEqual(session.read({ afterIndex: 1 }), [])
  })

  it('拒绝无效事件和读取参数，关闭后清空历史并拒绝读写', () => {
    const session = new Session({ id: 'session-2' })

    assert.throws(() => new Session({ id: '  ' }), /ID 不能为空/)
    assert.throws(() => session.append({ type: '  ' }), /事件类型不能为空/)
    assert.throws(() => session.read({ afterIndex: -2 }), /历史游标/)
    assert.throws(() => session.read({ limit: -1 }), /读取数量/)

    session.append({ type: 'user-input', text: '临时记录' })
    session.close()
    session.close()
    assert.equal(session.size, 0)
    assert.throws(() => session.read(), /已关闭/)
    assert.throws(() => session.append({ type: 'user-input' }), /已关闭/)
  })
})

describe('Session Harness 插件', () => {
  let framework: AgentFramework | undefined

  afterEach(async () => {
    await framework?.manager.disposeAll()
    framework = undefined
  })

  it('通过 Preset 装配独立 Session，并在 Agent 销毁时释放历史', async () => {
    framework = await bootstrapAgents()
    assert.ok(framework.plugins.get('session'))
    framework.presets.register({
      id: 'session-test', version: '1', role: 'character',
      plugins: [
        { pluginId: 'mock-loop' },
        { pluginId: 'session', config: { sessionId: 'session-agent-a' } },
      ],
    })

    const first = await framework.manager.create({ id: 'agent-a', presetId: 'session-test' })
    const second = await framework.manager.create({ id: 'agent-b', presetId: 'session-test' })
    const firstSession = first.context.get('session')
    const secondSession = second.context.get('session')
    assert.ok(firstSession)
    assert.ok(secondSession)
    assert.equal(firstSession.id, 'session-agent-a')
    assert.notEqual(firstSession, secondSession)
    firstSession.append({ type: 'user-input', text: '只属于 A' })
    assert.equal(secondSession.size, 0)

    await framework.manager.dispose('agent-a')
    assert.equal(first.context.get('session'), undefined)
    assert.equal(firstSession.size, 0)
    assert.equal(secondSession.size, 0)
  })
})
