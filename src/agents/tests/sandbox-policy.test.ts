import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SandboxPolicyService, sandboxPolicyPlugin, sandboxPolicyPluginDefinition } from '@fly-novel/sandbox-policy'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

test('可信配置默认只读并拒绝无效模式、相对路径或缺少可写根', () => {
  assert.equal(new SandboxPolicyService().resolve().mode, 'read-only')
  assert.throws(() => new SandboxPolicyService({ mode: 'workspace-write' }), /显式配置/)
  assert.throws(() => new SandboxPolicyService({ mode: 'workspace-write', workspaceRoot: 'relative' }), /绝对路径/)
  assert.throws(() => new SandboxPolicyService({ mode: 'workspace-write', workspaceRoot: join(tmpdir(), 'missing-sandbox-root-for-test') }))
  assert.throws(() => new SandboxPolicyService({ mode: 'unknown' as never }), /模式无效/)
})

test('未显式装配策略的 Agent 不继承根作用域策略', async t => {
  const framework = await bootstrapAgents()
  const root = framework.context.plugin(sandboxPolicyPlugin, { mode: 'danger-full-access' })
  await root
  t.after(async () => { await framework.manager.disposeAll(); await root.dispose() })
  const agent = await createTestAgent(framework, { id: 'no-policy', presetId: 'character-agent' })
  assert.equal(framework.context.sandboxPolicy.resolve().mode, 'danger-full-access')
  assert.equal(agent.context.get('sandboxPolicy'), undefined)
})

test('无效配置导致 Agent 初始化失败且不留下实例', async t => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.plugins.register(sandboxPolicyPluginDefinition)
  framework.presets.register({ id: 'sandbox-invalid', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'sandbox-policy' }]) })
  await assert.rejects(createTestAgent(framework, { id: 'bad-policy', presetId: 'sandbox-invalid', pluginConfigs: { 'sandbox-policy': { mode: 'workspace-write' } } }), /显式配置/)
  assert.throws(() => framework.manager.get('bad-policy'), /不存在/)
  const recovered = await createTestAgent(framework, { id: 'bad-policy', presetId: 'sandbox-invalid' })
  assert.equal(recovered.context.sandboxPolicy.resolve().mode, 'read-only')
})

test('各 Agent 的配置独立且不可被原始参数修改', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fly-policy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = await realpath(directory)
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.plugins.register(sandboxPolicyPluginDefinition)
  framework.presets.register({ id: 'sandbox-policy-test', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'sandbox-policy' }]) })
  const extra: string[] = [root]
  const a = await createTestAgent(framework, { id: 'a', presetId: 'sandbox-policy-test', pluginConfigs: { 'sandbox-policy': { mode: 'workspace-write', workspaceRoot: root, additionalWritableRoots: extra } } })
  const b = await createTestAgent(framework, { id: 'b', presetId: 'sandbox-policy-test' })
  extra.push(join(root, 'injected'))
  assert.deepEqual(a.context.sandboxPolicy.resolve(), { mode: 'workspace-write', workspaceRoot: root, additionalWritableRoots: [root] })
  assert.equal(b.context.sandboxPolicy.resolve().mode, 'read-only')
  assert.notEqual(a.context.sandboxPolicy, b.context.sandboxPolicy)
  assert.ok(Object.isFrozen(a.context.sandboxPolicy.resolve()))
  assert.ok(Object.isFrozen(a.context.sandboxPolicy.resolve().additionalWritableRoots))
  await framework.manager.dispose('a')
  assert.equal(b.context.sandboxPolicy.resolve().mode, 'read-only')
})
