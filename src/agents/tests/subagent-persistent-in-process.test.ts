import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPersistentAgentCreator, createPersistentAgentRouter } from '@fly-novel/subagent-persistent-in-process'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

test('persistent 与 spawn 并存，首次创建后恢复且运行期间独占', async t => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const modes: object[] = []
  let releases = 0
  const create = createPersistentAgentCreator({ presetId: 'special', sessionMode: 'create', async create(input) {
    modes.push(input)
    return { agent: { async run({ prompt }) { return { content: prompt } }, cancel() {} }, async dispose() { releases++ } }
  } })
  framework.presets.register({ id: 'persistent-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-persistent-in-process' }, { pluginId: 'subagent-spawn-in-process' },
  ]) })
  const parent = await createTestAgent(framework, { id: 'parent', presetId: 'persistent-parent', pluginConfigs: {
    'subagent-persistent-in-process': { create }, 'subagent-spawn-in-process': { create },
  } })
  assert.ok(parent.context.subagents.getProvider('persistent'))
  assert.ok(parent.context.subagents.getProvider('spawn'))
  const input = { parent, presetId: 'special', prompt: '第一次', signal: new AbortController().signal }
  await assert.rejects(parent.context.subagents.start('persistent', { ...input, parameters: { sessionId: 'untrusted' } }), /不支持创建参数/)
  await assert.rejects(parent.context.subagents.start('persistent', { ...input, presetId: 'other' }), /Preset/)
  const first = await parent.context.subagents.start('persistent', input)
  await assert.rejects(parent.context.subagents.start('persistent', input), /正在使用/)
  assert.deepEqual(await first.result, { output: '第一次', stopReason: 'completed' })
  await Promise.all([first.dispose(), first.dispose()])
  const second = await parent.context.subagents.start('persistent', { ...input, prompt: '第二次' })
  assert.notEqual(first.id, second.id)
  assert.deepEqual(await second.result, { output: '第二次', stopReason: 'completed' })
  await second.dispose()
  assert.deepEqual(modes, [{ sessionMode: 'create', initial: true }, { sessionMode: 'resume', initial: false }])
  assert.equal(releases, 2)
})

test('启动中取消会释放迟到实例，之后恢复已创建会话', async t => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  let finish!: () => void
  let enter!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  const modes: string[] = []
  let releases = 0
  const create = createPersistentAgentCreator({ presetId: 'special', sessionMode: 'create', async create(input) {
    modes.push(input.sessionMode)
    if (modes.length === 1) { enter(); await gate }
    return { agent: { async run() { return { content: '完成' } }, cancel() {} }, async dispose() { releases++ } }
  } })
  framework.presets.register({ id: 'persistent-cancel', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-persistent-in-process' },
  ]) })
  const parent = await createTestAgent(framework, { id: 'parent', presetId: 'persistent-cancel', pluginConfigs: { 'subagent-persistent-in-process': { create } } })
  const controller = new AbortController()
  const started = parent.context.subagents.start('persistent', { parent, presetId: 'special', prompt: '任务', signal: controller.signal })
  const rejected = assert.rejects(started, /取消/)
  await entered
  controller.abort(new Error('取消'))
  finish()
  await rejected
  assert.equal(releases, 1)
  const run = await parent.context.subagents.start('persistent', { parent, presetId: 'special', prompt: '继续', signal: new AbortController().signal })
  await run.result; await run.dispose()
  assert.deepEqual(modes, ['create', 'resume'])
})

test('释放失败保留身份占用，避免继续使用未知资源状态', async () => {
  const create = createPersistentAgentCreator({ presetId: 'special', sessionMode: 'resume', async create() {
    return { agent: { async run() { return { content: '完成' } }, cancel() {} }, async dispose() { throw new Error('释放失败') } }
  } })
  const request = { parent: { info: { identity: { id: 'parent' } } }, presetId: 'special', prompt: '任务', signal: new AbortController().signal }
  const handle = await create(request)
  await assert.rejects(handle.dispose(), /释放失败/)
  await assert.rejects(create(request), /正在使用/)
})

test('同一 Provider 可以按可信绑定路由不同的持续身份', async () => {
  const make = (presetId: string) => createPersistentAgentCreator({ presetId, sessionMode: 'resume', async create() {
    return { agent: { async run() { return { content: presetId } }, cancel() {} }, async dispose() {} }
  } })
  const bindings = { history: make('history'), character: make('character') }
  const route = createPersistentAgentRouter(bindings)
  const request = { parent: { info: { identity: { id: 'parent' } } }, prompt: '任务', signal: new AbortController().signal }
  const first = await route({ ...request, presetId: 'history' })
  const second = await route({ ...request, presetId: 'character' })
  assert.deepEqual(await first.agent.run({ prompt: '任务' }), { content: 'history' })
  assert.deepEqual(await second.agent.run({ prompt: '任务' }), { content: 'character' })
  await assert.rejects(route({ ...request, presetId: 'unknown' }), /绑定/)
  await Promise.all([first.dispose(), second.dispose()])
})
