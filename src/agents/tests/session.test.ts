import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { MessageId, UserMessage } from '@fly-novel/llm'
import { bootstrapAgents } from '../core/bootstrap.js'
import type { AgentFramework } from '../core/bootstrap.js'
import { Session, SessionManager } from '@fly-novel/session'

declare module '@fly-novel/session' {
  interface SessionEventMap {
    'plugin/note': { readonly text: string }
  }
}

function userMessage(text: string): UserMessage {
  return {
    id: 'message-user-1' as MessageId,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

describe('Session 事件与消息类型', () => {
  it('用事件类型区分运行记录、用户消息和插件扩展事件', () => {
    const session = new Session({ id: 'session-1' })
    const incoming = userMessage('第一句')

    const turnStart = session.append('turn/start', { turn: 0 })
    const userEvent = session.append('user/message', incoming)
    const pluginEvent = session.append('plugin/note', { text: '插件自有事件' })
    incoming.content[0] = { type: 'text', text: '调用方后来修改' }

    assert.equal(turnStart.seq, 0)
    assert.equal(turnStart.type, 'turn/start')
    assert.equal(turnStart.data.turn, 0)
    assert.equal(userEvent.seq, 1)
    assert.equal(userEvent.type, 'user/message')
    assert.equal(userEvent.data.role, 'user')
    assert.equal(userEvent.data.content[0]?.type, 'text')
    assert.deepEqual(userEvent.data.content[0], { type: 'text', text: '第一句' })
    assert.equal(pluginEvent.type, 'plugin/note')
    assert.equal(pluginEvent.data.text, '插件自有事件')

    const events = session.read()
    const messageEvents = events.filter((event) =>
      event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result',
    )
    assert.equal(messageEvents.length, 1)
  })

  it('按追加顺序读取事件，支持游标和数量限制', () => {
    const session = new Session({ id: 'session-2', createdAt: new Date('2026-01-01T00:00:00.000Z') })
    session.append('turn/start', { turn: 0 })
    session.append('user/message', userMessage('第一句'))
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })

    assert.equal(session.id, 'session-2')
    assert.equal(session.size, 3)
    assert.deepEqual(session.read().map(({ type, seq }) => [type, seq]), [
      ['turn/start', 0],
      ['user/message', 1],
      ['turn/end', 2],
    ])
    assert.deepEqual(session.read({ afterIndex: 0, limit: 1 }).map(({ type }) => type), ['user/message'])
    assert.deepEqual(session.read({ afterIndex: 2 }), [])
  })

  it('拒绝无效读取参数，关闭后清空历史并拒绝读写', () => {
    const session = new Session({ id: 'session-3' })

    assert.throws(() => new Session({ id: '  ' }), /ID 不能为空/)
    assert.throws(() => session.read({ afterIndex: -2 }), /历史游标/)
    assert.throws(() => session.read({ limit: -1 }), /读取数量/)

    session.append('user/message', userMessage('临时记录'))
    session.close()
    session.close()
    assert.equal(session.size, 0)
    assert.throws(() => session.read(), /已关闭/)
    assert.throws(() => session.append('turn/start', { turn: 1 }), /已关闭/)
  })
})

describe('Session Harness 插件', () => {
  let framework: AgentFramework | undefined

  afterEach(async () => {
    await framework?.manager.disposeAll()
    framework = undefined
  })

  it('创建、查询、列举和关闭多个 Session', () => {
    const sessions = new SessionManager()
    const first = sessions.create('session-a')
    const second = sessions.create('session-b')

    assert.equal(sessions.get('session-a'), first)
    assert.deepEqual(sessions.list(), [first, second])
    assert.throws(() => sessions.create('session-a'), /已存在/)
    assert.equal(sessions.close('missing'), false)
    assert.equal(sessions.close(' session-a '), true)
    assert.equal(sessions.get('session-a'), undefined)
    assert.deepEqual(sessions.list(), [second])
    assert.equal(first.size, 0)
    assert.throws(() => first.read(), /已关闭/)

    sessions.closeAll()
    sessions.closeAll()
    assert.deepEqual(sessions.list(), [])
    assert.throws(() => sessions.create(), /Manager 已关闭/)
  })

  it('通过 Preset 装配 Agent 隔离的 Session Manager，并在 Agent 销毁时关闭所有会话', async () => {
    framework = await bootstrapAgents()
    assert.ok(framework.plugins.get('session'))
    framework.presets.register({
      id: 'session-test', version: '1', role: 'character',
      plugins: [
        { pluginId: 'mock-loop' },
        { pluginId: 'session' },
      ],
    })

    const first = await framework.manager.create({ id: 'agent-a', presetId: 'session-test' })
    const second = await framework.manager.create({ id: 'agent-b', presetId: 'session-test' })
    const firstSessions = first.context.get('sessions')
    const secondSessions = second.context.get('sessions')
    assert.ok(firstSessions)
    assert.ok(secondSessions)
    assert.notEqual(firstSessions, secondSessions)
    const firstSession = firstSessions.create('session-agent-a')
    const secondSession = secondSessions.create('session-agent-b')
    firstSession.append('user/message', userMessage('只属于 A'))
    assert.equal(secondSession.size, 0)

    await framework.manager.dispose('agent-a')
    assert.equal(first.context.get('sessions'), undefined)
    assert.equal(firstSession.size, 0)
    assert.equal(secondSession.size, 0)
    assert.deepEqual(firstSessions.list(), [])
    assert.equal(secondSessions.get('session-agent-b'), secondSession)
  })
})
