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
