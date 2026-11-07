import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ForkHistorySource } from '@fly-novel/agent-loop'
import { jsonlSessionPersistencePlugin } from '@fly-novel/agents'
import { fsObservationPolicyPlugin, fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import { FsTargetKey, FsVersion } from '../plugins/fs/fs/index.js'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

const target = { targetKey: FsTargetKey('file'), displayPath: 'file' }
const fallback = () => undefined

async function setup() {
  const framework = await bootstrapAgents()
  framework.plugins.register(fsObservationPolicyPluginDefinition)
  framework.presets.register({ id: 'observation-lifecycle', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }]) })
  framework.presets.register({ id: 'observation-lifecycle-policy', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'fs-observation-policy' }]) })
  return framework
}

test('释放插件后监听器和观察消失，重复释放及重新装配安全', async t => {
  const framework = await setup()
  t.after(() => framework.manager.disposeAll())
  const agent = await createTestAgent(framework, { id: 'life', presetId: 'observation-lifecycle' })
  const actor = { agent: agent.context.tools.agent, session: agent.context.sessions.list()[0]! }
  const scope = agent.context.plugin(fsObservationPolicyPlugin)
  await scope
  agent.context.emit('fs/observed', target, { kind: 'present', version: FsVersion('v1') }, actor)
  assert.deepEqual(await agent.context.waterfall('fs/edit-intent', target, actor, fallback), { version: 'v1' })
  await scope.dispose()
  await scope.dispose()
  assert.equal(await agent.context.waterfall('fs/edit-intent', target, actor, fallback), undefined)
  agent.context.emit('fs/observed', target, { kind: 'present', version: FsVersion('ignored') }, actor)
  const replacement = agent.context.plugin(fsObservationPolicyPlugin)
  await replacement
  t.after(() => replacement.dispose())
  await assert.rejects(agent.context.waterfall('fs/edit-intent', target, actor, fallback), { code: 'FS_NOT_OBSERVED' })
})

test('失败初始化不会残留监听器或阻止重新装配', async t => {
  const framework = await setup()
  t.after(() => framework.manager.disposeAll())
  const agent = await createTestAgent(framework, { id: 'failure', presetId: 'observation-lifecycle' })
  const actor = { agent: agent.context.tools.agent, session: agent.context.sessions.list()[0]! }
  const failed = agent.context.plugin(ctx => {
    ctx.plugin(fsObservationPolicyPlugin)
    throw new Error('初始化失败')
  })
  await assert.rejects(failed.await(), /初始化失败/)
  await failed.dispose()
  assert.equal(await agent.context.waterfall('fs/edit-intent', target, actor, fallback), undefined)
  const replacement = agent.context.plugin(fsObservationPolicyPlugin)
  await replacement
  t.after(() => replacement.dispose())
  await assert.rejects(agent.context.waterfall('fs/edit-intent', target, actor, fallback), { code: 'FS_NOT_OBSERVED' })
})

test('销毁期间受控等待的意图在释放后不访问旧状态', async t => {
  const framework = await setup()
  t.after(() => framework.manager.disposeAll())
  const agent = await createTestAgent(framework, { id: 'pending', presetId: 'observation-lifecycle' })
  const actor = { agent: agent.context.tools.agent, session: agent.context.sessions.list()[0]! }
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const blocker = agent.context.plugin(ctx => {
    ctx.on('fs/edit-intent', async (_target, _actor, next) => { entered(); await gate; return next() })
  })
  await blocker
  t.after(() => blocker.dispose())
  const scope = agent.context.plugin(fsObservationPolicyPlugin)
  await scope
  agent.context.emit('fs/observed', target, { kind: 'present', version: FsVersion('v1') }, actor)
  const pending = agent.context.waterfall('fs/edit-intent', target, actor, fallback)
  await started
  await scope.dispose()
  release()
  assert.equal(await pending, undefined)
  await blocker.dispose()
  const replacement = agent.context.plugin(fsObservationPolicyPlugin)
  await replacement
  t.after(() => replacement.dispose())
  await assert.rejects(agent.context.waterfall('fs/edit-intent', target, actor, fallback), { code: 'FS_NOT_OBSERVED' })
})

test('恢复的持久化 Session 和 Fork 的新 Session 不继承观察', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fly-observation-resume-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const framework = await setup()
  const backend = framework.context.plugin(jsonlSessionPersistencePlugin, { root })
  await backend
  t.after(async () => { await framework.manager.disposeAll(); await backend.dispose() })
  const create = (id: string, loop: object) => createTestAgent(framework, { id, presetId: 'observation-lifecycle-policy', pluginConfigs: { 'agent-loop-runtime': { provider: 'test-provider', model: 'test-model', ...loop } } })
  const parent = await create('parent', { sessionId: 'resume-id' })
  await parent.run({ prompt: 'history' })
  const parentSession = parent.context.sessions.list()[0]!
  const parentActor = { agent: parent.context.tools.agent, session: parentSession }
  parent.context.emit('fs/observed', target, { kind: 'present', version: FsVersion('old') }, parentActor)
  const loop = parent.context.agentLoop
  assert.ok('snapshotForkHistory' in loop && typeof loop.snapshotForkHistory === 'function')
  const history = (loop as ForkHistorySource).snapshotForkHistory()
  const fork = await create('fork', { initialSessionEvents: history })
  const forkActor = { agent: fork.context.tools.agent, session: fork.context.sessions.list()[0]! }
  assert.notEqual(forkActor.session, parentSession)
  await assert.rejects(fork.context.waterfall('fs/edit-intent', target, forkActor, fallback), { code: 'FS_NOT_OBSERVED' })
  await framework.manager.dispose('parent')
  const resumed = await create('resumed', { resumeSessionId: 'resume-id' })
  const resumedSession = resumed.context.sessions.list()[0]!
  assert.equal(resumedSession.id, parentSession.id)
  assert.notEqual(resumedSession, parentSession)
  const resumedActor = { agent: resumed.context.tools.agent, session: resumedSession }
  await assert.rejects(resumed.context.waterfall('fs/edit-intent', target, resumedActor, fallback), { code: 'FS_NOT_OBSERVED' })
})
