import assert from 'node:assert/strict'
import test from 'node:test'
import { FsTargetKey, FsVersion } from '../plugins/fs/fs/index.js'
import { fsObservationPolicyPlugin, fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

const target = { targetKey: FsTargetKey('target'), displayPath: 'target' }

test('显式策略按工具身份和会话路由，销毁后释放监听器', async () => {
  const framework = await bootstrapAgents()
  framework.plugins.register(fsObservationPolicyPluginDefinition)
  framework.presets.register({ id: 'policy-on', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'fs-observation-policy' }]) })
  framework.presets.register({ id: 'policy-off', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }]) })
  try {
    const a = await createTestAgent(framework, { id: 'policy-a', presetId: 'policy-on' })
    const b = await createTestAgent(framework, { id: 'policy-b', presetId: 'policy-on' })
    const c = await createTestAgent(framework, { id: 'policy-c', presetId: 'policy-off' })
    const sa = a.context.sessions.list()[0]!
    const sb = b.context.sessions.list()[0]!
    const actorA = { agent: a.context.tools.agent, session: sa }
    const actorB = { agent: b.context.tools.agent, session: sb }
    const actorC = { agent: c.context.tools.agent }
    const fallback = () => undefined
    const duplicate = a.context.plugin(fsObservationPolicyPlugin)
    await assert.rejects(duplicate.await(), /已装配/)
    await duplicate.dispose()
    a.context.emit('fs/observed', target, { kind: 'present', version: FsVersion('a') }, actorA)
    assert.deepEqual(await a.context.waterfall('fs/edit-intent', target, actorA, fallback), { version: 'a' })
    await assert.rejects(b.context.waterfall('fs/edit-intent', target, actorB, fallback), { code: 'FS_NOT_OBSERVED' })
    assert.equal(await c.context.waterfall('fs/edit-intent', target, actorC, fallback), undefined)
    await assert.rejects(a.context.waterfall('fs/edit-intent', target, { ...actorA, session: sb }, fallback), /Session/)
    const extra = a.context.sessions.create('extra')
    await assert.rejects(a.context.waterfall('fs/edit-intent', target, { ...actorA, session: extra }, fallback), { code: 'FS_NOT_OBSERVED' })
    await a.context.sessions.close('extra')
    await assert.rejects(a.context.waterfall('fs/edit-intent', target, { ...actorA, session: extra }, fallback), /Session/)
    await framework.manager.dispose('policy-a')
    assert.equal(await b.context.waterfall('fs/edit-intent', target, actorA, fallback), undefined)
  } finally { await framework.manager.disposeAll() }
})

