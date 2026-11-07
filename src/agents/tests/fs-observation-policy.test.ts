import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { FsTargetKey, FsVersion } from '../plugins/fs/fs/index.js'
import type { FsTarget, FsWriteIntent } from '../plugins/fs/fs/index.js'
import { fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

const policyRequire = createRequire(require.resolve('@fly-novel/fs-observation-policy'))
const { FsError } = policyRequire('@fly-novel/fs') as typeof import('../plugins/fs/fs/index.js')
const target = { targetKey: FsTargetKey('one'), displayPath: 'one' }
const alias = { targetKey: target.targetKey, displayPath: 'alias' }
const other = { targetKey: FsTargetKey('other'), displayPath: 'other' }
const absent = { kind: 'absent' } as const
const present = (version: string) => ({ kind: 'present' as const, version: FsVersion(version) })
const fallback = () => undefined

async function setup() {
  const framework = await bootstrapAgents()
  framework.plugins.register(fsObservationPolicyPluginDefinition)
  framework.presets.register({ id: 'observe-policy', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'fs-observation-policy' }]) })
  const agent = await createTestAgent(framework, { id: 'owner-a', presetId: 'observe-policy' })
  const session = agent.context.sessions.list()[0]!
  const actor = () => ({ agent: agent.context.tools.agent, session })
  return { framework, agent, session, actor }
}

test('同一所有者的观察按目标身份同步更新，写入、编辑和删除遵循状态表', async (t) => {
  const { framework, agent, actor } = await setup()
  t.after(() => framework.manager.disposeAll())
  const ctx = agent.context
  const write = (path: FsTarget = target) => ctx.waterfall('fs/write-intent', path, actor(), fallback)
  const edit = (path: FsTarget = target) => ctx.waterfall('fs/edit-intent', path, actor(), fallback)
  const remove = (path: FsTarget = target) => ctx.waterfall('fs/delete-intent', path, actor(), fallback)
  const rejected = async (action: () => Promise<unknown>, code: string) => {
    let result: Promise<unknown> | undefined
    assert.doesNotThrow(() => { result = action() })
    assert.ok(result instanceof Promise)
    await assert.rejects(result, (error: unknown) => error instanceof FsError && error.code === code)
  }
  assert.deepEqual(await write(), { kind: 'createIfAbsent' })
  await rejected(edit, 'FS_NOT_OBSERVED')
  await rejected(remove, 'FS_NOT_OBSERVED')
  ctx.emit('fs/observed', target, absent, actor())
  assert.deepEqual(await write(), { kind: 'createIfAbsent' })
  await rejected(edit, 'FS_NOT_FOUND')
  await rejected(remove, 'FS_NOT_FOUND')
  ctx.emit('fs/observed', target, present('v1'), actor())
  assert.deepEqual(await write(alias), { kind: 'replaceIfVersion', version: 'v1' })
  assert.deepEqual(await edit(alias), { version: 'v1' })
  assert.deepEqual(await remove(), { version: 'v1' })
  await rejected(() => edit(other), 'FS_NOT_OBSERVED')
  ctx.emit('fs/observed', alias, present('v2'), actor())
  assert.deepEqual(await edit(), { version: 'v2' })
  ctx.emit('fs/observed', alias, absent, actor())
  await rejected(edit, 'FS_NOT_FOUND')
  ctx.emit('fs/observed', target, present('v3'), actor())
  assert.deepEqual(await remove(alias), { version: 'v3' })
})

test('同一 Agent 的不同会话及缺少会话的调用不共享观察', async (t) => {
  const { framework, agent, actor } = await setup()
  t.after(() => framework.manager.disposeAll())
  const ctx = agent.context
  const second = { agent: ctx.tools.agent, session: ctx.sessions.create('other-session') }
  const noSession = { agent: ctx.tools.agent }
  ctx.emit('fs/observed', target, present('one'), actor())
  ctx.emit('fs/observed', target, present('ignored'), noSession)
  await assert.rejects(ctx.waterfall('fs/edit-intent', target, second, fallback), { code: 'FS_NOT_OBSERVED' })
  await assert.rejects(ctx.waterfall('fs/delete-intent', target, noSession, fallback), { code: 'FS_NOT_OBSERVED' })
  assert.deepEqual(await ctx.waterfall('fs/write-intent', target, noSession, fallback), { kind: 'createIfAbsent' })
  ctx.emit('fs/observed', target, present('two'), second)
  assert.deepEqual(await ctx.waterfall('fs/edit-intent', target, actor(), fallback), { version: 'one' })
  assert.deepEqual(await ctx.waterfall('fs/edit-intent', target, second, fallback), { version: 'two' })
})

test('多个策略按身份委派，未知 actor 到达后续监听器，匹配时短路', async (t) => {
  const { framework, agent: a, actor } = await setup()
  t.after(() => framework.manager.disposeAll())
  const b = await createTestAgent(framework, { id: 'owner-b', presetId: 'observe-policy' })
  const bActor = { agent: b.context.tools.agent, session: b.context.sessions.list()[0]! }
  const calls: string[] = []
  const last = framework.context.plugin(ctx => {
    ctx.on('fs/write-intent', async (_target, _actor, next) => { calls.push('last'); return next() })
  })
  await last
  t.after(() => last.dispose())
  a.context.emit('fs/observed', target, present('a'), actor())
  b.context.emit('fs/observed', target, present('b'), bActor)
  assert.deepEqual(await b.context.waterfall('fs/write-intent', target, bActor, () => { calls.push('default'); return undefined }), { kind: 'replaceIfVersion', version: 'b' })
  assert.deepEqual(await a.context.waterfall('fs/write-intent', target, actor(), () => { calls.push('default'); return undefined }), { kind: 'replaceIfVersion', version: 'a' })
  assert.equal(calls.length, 0)
  assert.equal(await a.context.waterfall('fs/write-intent', target, {}, () => { calls.push('default'); return undefined }), undefined)
  assert.deepEqual(calls, ['last', 'default'])
  assert.equal(await a.context.waterfall('fs/write-intent', target, undefined, fallback), undefined)
  assert.equal(await a.context.waterfall('fs/write-intent', target, { agent: { ...a.context.tools.agent } }, fallback), undefined)
})

test('策略实例安装顺序反转后仍按身份隔离', async () => {
  for (const order of [['first', 'second'], ['second', 'first']]) {
    const framework = await bootstrapAgents()
    framework.plugins.register(fsObservationPolicyPluginDefinition)
    framework.presets.register({ id: 'order-policy', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'fs-observation-policy' }]) })
    try {
      const first = await createTestAgent(framework, { id: order[0]!, presetId: 'order-policy' })
      const second = await createTestAgent(framework, { id: order[1]!, presetId: 'order-policy' })
      const firstActor = { agent: first.context.tools.agent, session: first.context.sessions.list()[0]! }
      const secondActor = { agent: second.context.tools.agent, session: second.context.sessions.list()[0]! }
      second.context.emit('fs/observed', target, present(order[1]!), secondActor)
      await assert.rejects(first.context.waterfall('fs/edit-intent', target, firstActor, fallback), { code: 'FS_NOT_OBSERVED' })
      assert.deepEqual(await second.context.waterfall('fs/edit-intent', target, secondActor, fallback), { version: order[1] })
    } finally { await framework.manager.disposeAll() }
  }
})

test('先注册的决策者短路策略，事件驱动调用方将策略保护交给后端替身', async (t) => {
  const framework = await bootstrapAgents()
  const blocker = framework.context.plugin(ctx => {
    ctx.on('fs/write-intent', async () => ({ kind: 'createIfAbsent' }))
  })
  await blocker
  framework.plugins.register(fsObservationPolicyPluginDefinition)
  framework.presets.register({ id: 'guard-test', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'fs-observation-policy' }]) })
  t.after(async () => { await framework.manager.disposeAll(); await blocker.dispose() })
  const agent = await createTestAgent(framework, { id: 'guard', presetId: 'guard-test' })
  const actor = { agent: agent.context.tools.agent, session: agent.context.sessions.list()[0]! }
  agent.context.emit('fs/observed', target, present('v1'), actor)
  assert.deepEqual(await agent.context.waterfall('fs/write-intent', target, actor, fallback), { kind: 'createIfAbsent' })
  await blocker.dispose()
  const received: Array<FsWriteIntent | { version: string } | undefined> = []
  const backend = {
    write: async (guard: FsWriteIntent | undefined) => { received.push(guard); throw new Error('后端拒绝提交') },
    edit: async (guard: { version: string } | undefined) => { received.push(guard) },
    remove: async (guard: { version: string } | undefined) => { received.push(guard) },
  }
  const guard = await agent.context.waterfall('fs/write-intent', target, actor, fallback)
  await assert.rejects(backend.write(guard), /后端拒绝提交/)
  assert.deepEqual(received, [{ kind: 'replaceIfVersion', version: 'v1' }])
  assert.deepEqual(await agent.context.waterfall('fs/edit-intent', target, actor, fallback), { version: 'v1' })
  await backend.edit(await agent.context.waterfall('fs/edit-intent', target, actor, fallback))
  await backend.remove(await agent.context.waterfall('fs/delete-intent', target, actor, fallback))
  assert.deepEqual(received, [{ kind: 'replaceIfVersion', version: 'v1' }, { version: 'v1' }, { version: 'v1' }])
})
