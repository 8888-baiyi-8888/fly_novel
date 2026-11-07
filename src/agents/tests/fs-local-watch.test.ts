import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'
import type { Context as PluginContext } from '@deepseek-ai/cordis'

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'fly-fs-watch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const scope = await ctx.plugin(LocalFileSystem, { cwd: dir })
  t.after(() => scope.dispose())
  return { dir, fs: ctx.fs as LocalFileSystem }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function notifications() {
  let next = deferred()
  let count = 0
  return {
    callback(error?: Error) {
      if (error) next.reject(error)
      else { count++; next.resolve() }
    },
    wait() { return next.promise },
    reset() { next = deferred() },
    count() { return count },
  }
}

test('目录监听准备完成后通知，关闭后不再接收后续变更并可重复关闭', { timeout: 15000 }, async t => {
  const { dir, fs } = await setup(t)
  const target = await fs.resolve('.')
  const watched = notifications()
  const observer = notifications()
  const signal = new AbortController()
  const close = await fs.watch(target, watched.callback, signal.signal)
  t.after(close)
  const closeObserver = await fs.watch(target, observer.callback, new AbortController().signal)
  t.after(closeObserver)
  await writeFile(join(dir, 'first'), '1')
  await watched.wait()
  await observer.wait()
  await close()
  await close()
  const afterClose = watched.count()
  observer.reset()
  await writeFile(join(dir, 'second'), '2')
  await observer.wait()
  assert.equal(watched.count(), afterClose)
})

test('文件和缺失文件监听可观察目标变化', { timeout: 15000 }, async t => {
  const { dir, fs } = await setup(t)
  const existingPath = join(dir, 'existing')
  await writeFile(existingPath, 'original')
  const existing = notifications()
  const closeExisting = await fs.watch(await fs.resolve('existing'), existing.callback, new AbortController().signal)
  t.after(closeExisting)
  await writeFile(existingPath, 'changed-content')
  await existing.wait()
  const missing = notifications()
  const closeMissing = await fs.watch(await fs.resolve('missing'), missing.callback, new AbortController().signal)
  t.after(closeMissing)
  await writeFile(join(dir, 'missing'), 'created')
  await missing.wait()
  assert.ok(existing.count() >= 1)
  assert.ok(missing.count() >= 1)
})

test('初始化取消和元数据失败传播', { timeout: 10000 }, async t => {
  const { fs } = await setup(t)
  const target = await fs.resolve('.')
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(fs.watch(target, () => {}, aborted.signal), { name: 'AbortError' })
  const started = deferred()
  const proceed = deferred()
  const original = fs.stat.bind(fs)
  fs.stat = async (...args) => { started.resolve(); await proceed.promise; return original(...args) }
  const pending = new AbortController()
  const result = fs.watch(target, () => {}, pending.signal)
  await started.promise
  pending.abort()
  proceed.resolve()
  await assert.rejects(result, { code: 'FS_ABORTED' })
  const failure = new Error('模拟元数据失败')
  fs.stat = async () => { throw failure }
  await assert.rejects(fs.watch(target, () => {}, new AbortController().signal), failure)
  fs.stat = original
})

test('Harness 销毁服务不替调用方关闭真实监听句柄', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fly-fs-watch-agent-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const provider = Object.assign(async (ctx: PluginContext) => {
    await ctx.plugin(LocalFileSystem, { cwd: dir })
  }, { provide: 'fs' as const })
  framework.plugins.register({ id: 'watch-local', version: '1', plugin: provider })
  framework.presets.register({ id: 'watch-local', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'watch-local' }]) })
  const agent = await createTestAgent(framework, { id: 'watch-agent', presetId: 'watch-local' })
  const fs = agent.context.get('fs')
  assert.ok(fs instanceof LocalFileSystem)
  const events = notifications()
  const signal = new AbortController()
  const close = await fs.watch(await fs.resolve('.'), events.callback, signal.signal)
  t.after(close)
  signal.abort()
  await framework.manager.dispose('watch-agent')
  assert.equal(agent.context.get('fs'), undefined)
  await writeFile(join(dir, 'after-dispose'), 'data')
  await events.wait()
  await close()
  await close()
})
