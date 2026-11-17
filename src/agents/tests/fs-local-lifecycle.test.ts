import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

test('真实本机后端显式装配到各 Agent 作用域并随作用域释放', async () => {
  const framework = await bootstrapAgents()
  const root = framework.context.plugin(LocalFileSystem, { cwd: process.cwd() })
  await root
  const provider = Object.assign(async (ctx: Context) => {
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
  }, { provide: 'fs' as const })
  framework.plugins.register({ id: 'local-fs-test', version: '1', plugin: provider })
  framework.presets.register({ id: 'local-fs-test', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'local-fs-test' }]) })
  try {
    const unmounted = await createTestAgent(framework, { id: 'local-unmounted', presetId: 'character-agent' })
    assert.equal(unmounted.context.get('fs'), undefined)
    const first = await createTestAgent(framework, { id: 'local-first', presetId: 'local-fs-test' })
    const second = await createTestAgent(framework, { id: 'local-second', presetId: 'local-fs-test' })
    assert.ok(first.context.get('fs') instanceof LocalFileSystem)
    assert.ok(second.context.get('fs') instanceof LocalFileSystem)
    assert.notEqual(first.context.get('fs'), second.context.get('fs'))
    assert.ok(framework.context.get('fs') instanceof LocalFileSystem)
    assert.notEqual(first.context.get('fs'), framework.context.get('fs'))
    await framework.manager.dispose('local-first')
    assert.equal(first.context.get('fs'), undefined)
    assert.ok(second.context.get('fs') instanceof LocalFileSystem)
  } finally {
    await framework.manager.disposeAll()
    await root.dispose()
  }
})

test('真实本机后端配置错误时 Agent 创建失败且不留下服务', async () => {
  const framework = await bootstrapAgents()
  const provider = Object.assign(async (ctx: Context) => {
    await ctx.plugin(LocalFileSystem, { diffBasisMaxBytes: 0 })
  }, { provide: 'fs' as const })
  framework.plugins.register({ id: 'invalid-local-fs', version: '1', plugin: provider })
  framework.presets.register({ id: 'invalid-local-fs', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'invalid-local-fs' }]) })
  try {
    await assert.rejects(createTestAgent(framework, { id: 'invalid-local', presetId: 'invalid-local-fs' }), /diffBasisMaxBytes/)
    assert.equal(framework.context.get('fs'), undefined)
    assert.throws(() => framework.manager.get('invalid-local'), /不存在/)
  } finally {
    await framework.manager.disposeAll()
  }
})

test('Windows 替换重试间隔可配置并拒绝无效值', async () => {
  const framework = await bootstrapAgents()
  const scope = framework.context.plugin(LocalFileSystem, { windowsReplaceRetryDelayMs: 0 })
  await scope
  assert.equal((framework.context.fs as LocalFileSystem).config.windowsReplaceRetryDelayMs, 0)
  await scope.dispose()
  for (const value of [-1, 1001, 0.5]) {
    const invalid = framework.context.plugin(LocalFileSystem, { windowsReplaceRetryDelayMs: value })
    await assert.rejects(Promise.resolve(invalid), /windowsReplaceRetryDelayMs/)
  }
})
