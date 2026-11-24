import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { sessionPlugin } from '@fly-novel/session'
import { createToolResultMessage, type ToolCallId } from '@fly-novel/llm'
import { observeWorldInitializationProgress } from '../world-initialization-progress.js'

test('进度提示显示委派等待和失败，结束后不再监听或输出', async () => {
  const context = new Context(); const scope = await context.plugin(sessionPlugin, {})
  try {
    const session = context.sessions.create('main'); const other = context.sessions.create('other')
    const lines: string[] = []
    const stop = observeWorldInitializationProgress({ context }, line => lines.push(line), 15)
    session.append('step/start', { turn: 1, step: 1 })
    const callId = 'map-call' as ToolCallId
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'delegate_map', arguments: '{"secret":"不可显示"}' })
    other.append('tool/call', { turn: 1, step: 1, callId: 'other-call' as ToolCallId, name: 'other', arguments: '{}' })
    await delay(50)
    assert.ok(lines.some(line => line.includes('主 Agent 第 1 步开始')))
    assert.ok(lines.some(line => line.includes('开始调用地图 Agent')))
    assert.ok(lines.some(line => line.includes('等待 地图 Agent') && line.includes('子 Agent 内部步骤不会实时显示')))
    assert.ok(lines.every(line => !line.includes('不可显示') && !line.includes('other')))
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [], isError: true }) })
    assert.ok(lines.some(line => line.includes('地图 Agent已返回：失败')))
    stop(); stop()
    const count = lines.length
    session.append('step/start', { turn: 1, step: 2 })
    await delay(40)
    assert.equal(lines.length, count)
  } finally { await scope.dispose() }
})
