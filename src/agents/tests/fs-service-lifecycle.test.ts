import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '../plugins/fs/fs/index.js'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

// 此替身只验证服务装配，不实现文件操作。
class TestFileSystem extends FileSystem {
  resolve(): never { throw new Error('未实现') }
  processPath(): never { throw new Error('未实现') }
  fileUrl(): never { throw new Error('未实现') }
  contains(): never { throw new Error('未实现') }
  stat(): never { throw new Error('未实现') }
  lstat(): never { throw new Error('未实现') }
  readText(): never { throw new Error('未实现') }
  streamText(): never { throw new Error('未实现') }
  readBytes(): never { throw new Error('未实现') }
  readByteRange(): never { throw new Error('未实现') }
  listDir(): never { throw new Error('未实现') }
  writeText(): never { throw new Error('未实现') }
  editText(): never { throw new Error('未实现') }
  patchText(): never { throw new Error('未实现') }
  deleteFile(): never { throw new Error('未实现') }
  moveFile(): never { throw new Error('未实现') }
}

const target = { targetKey: FsTargetKey('test'), displayPath: 'test' }

test('同一作用域不能重复注册文件服务，释放后可以重新注册', async () => {
  const framework = await bootstrapAgents()
  const first = framework.context.plugin(ctx => { new TestFileSystem(ctx) })
  await first
  try {
    const duplicate = framework.context.plugin(ctx => { new TestFileSystem(ctx) })
    await assert.rejects(duplicate.await())
    await duplicate.dispose()
    assert.ok(framework.context.get('fs'))
  } finally { await first.dispose() }
  assert.equal(framework.context.get('fs'), undefined)
  const replacement = framework.context.plugin(ctx => { new TestFileSystem(ctx) })
  try {
    await replacement
    assert.ok(framework.context.get('fs'))
  } finally { await replacement.dispose() }
})

test('未装配文件后端的 Agent 不继承根文件服务', async () => {
  const framework = await bootstrapAgents()
  const root = framework.context.plugin(ctx => { new TestFileSystem(ctx) })
  await root
  try {
    const agent = await createTestAgent(framework, { id: 'no-fs', presetId: 'character-agent' })
    assert.ok(framework.context.get('fs'))
    assert.equal(agent.context.get('fs'), undefined)
    await framework.manager.dispose('no-fs')
    assert.ok(framework.context.get('fs'))
  } finally {
    await framework.manager.disposeAll()
    await root.dispose()
  }
})

test('Harness 装配的文件服务按 Agent 隔离并随作用域释放', async () => {
  const framework = await bootstrapAgents()
  let cleanups = 0
  const plugin = Object.assign((ctx: Context) => {
    new TestFileSystem(ctx)
    ctx.effect(() => () => { cleanups++ })
  }, { provide: 'fs' as const })
  framework.plugins.register({ id: 'test-fs', version: '1', plugin })
  framework.presets.register({ id: 'test-fs', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'test-fs' }]) })
  try {
    const first = await createTestAgent(framework, { id: 'fs-first', presetId: 'test-fs' })
    const second = await createTestAgent(framework, { id: 'fs-second', presetId: 'test-fs' })
    assert.ok(first.context.get('fs') instanceof TestFileSystem)
    assert.notEqual(first.context.get('fs'), second.context.get('fs'))
    assert.equal(framework.context.get('fs'), undefined)
    await framework.manager.dispose('fs-first')
    await framework.manager.dispose('fs-first')
    assert.equal(first.context.get('fs'), undefined)
    assert.ok(second.context.get('fs'))
    assert.equal(cleanups, 1)
  } finally {
    await framework.manager.disposeAll()
  }
  assert.equal(cleanups, 2)
})

test('缺少文件服务依赖时创建失败且不留下服务', async () => {
  const framework = await bootstrapAgents()
  const root = framework.context.plugin(ctx => { new TestFileSystem(ctx) })
  await root
  const consumer = Object.assign((_ctx: Context) => {}, { inject: ['fs'] })
  framework.plugins.register({ id: 'needs-fs', version: '1', plugin: consumer })
  framework.presets.register({ id: 'needs-fs', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'needs-fs' }]) })
  try {
    await assert.rejects(createTestAgent(framework, { id: 'missing-fs', presetId: 'needs-fs' }), /依赖未就绪/)
    assert.ok(framework.context.get('fs'))
    assert.throws(() => framework.manager.get('missing-fs'), /不存在/)
  } finally { await framework.manager.disposeAll(); await root.dispose() }
})

test('后续插件启动失败时清理已经装配的文件服务', async () => {
  const framework = await bootstrapAgents()
  let service: TestFileSystem | undefined
  let cleaned = 0
  const provider = Object.assign((ctx: Context) => {
    service = new TestFileSystem(ctx)
    ctx.effect(() => () => { cleaned++ })
  }, { provide: 'fs' as const })
  const failing = Object.assign((ctx: Context) => {
    assert.ok(ctx.get('fs'))
    throw new Error('模拟启动失败')
  }, { inject: ['fs'] })
  framework.plugins.register({ id: 'fs-provider', version: '1', plugin: provider })
  framework.plugins.register({ id: 'fs-failing', version: '1', plugin: failing })
  framework.presets.register({ id: 'fs-failing', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'fs-provider' }, { pluginId: 'fs-failing' }]) })
  try {
    await assert.rejects(createTestAgent(framework, { id: 'fs-failing', presetId: 'fs-failing' }), /模拟启动失败/)
    assert.ok(service)
    assert.equal(cleaned, 1)
    assert.equal(framework.context.get('fs'), undefined)
    assert.throws(() => framework.manager.get('fs-failing'), /不存在/)
  } finally { await framework.manager.disposeAll() }
})

test('已初始化监听句柄由调用方关闭', async () => {
  const framework = await bootstrapAgents()
  let closes = 0
  class WatchingFileSystem extends TestFileSystem {
    override async watch(_target: typeof target, _changed: (error?: Error) => void, signal: AbortSignal) {
      signal.throwIfAborted()
      let closed = false
      return async () => { if (!closed) { closed = true; closes++ } }
    }
  }
  const scope = framework.context.plugin(ctx => { new WatchingFileSystem(ctx) })
  await scope
  const controller = new AbortController()
  const close = await framework.context.fs.watch(target, () => {}, controller.signal)
  controller.abort()
  await scope.dispose()
  assert.equal(closes, 0)
  await close()
  await close()
  assert.equal(closes, 1)
})

test('默认监听拒绝不支持，并传播已经取消的信号', async () => {
  const framework = await bootstrapAgents()
  const scope = framework.context.plugin(ctx => { new TestFileSystem(ctx) })
  await scope
  try {
    const fs = framework.context.get('fs')!
    await assert.rejects(fs.watch(target, () => {}, new AbortController().signal), (error: unknown) => error instanceof FsError && error.code === 'FS_IO_ERROR')
    const controller = new AbortController()
    const reason = new Error('取消监听')
    controller.abort(reason)
    assert.throws(() => fs.watch(target, () => {}, controller.signal), error => error === reason)
    assert.equal(fs.processPathFromHostPath('/host'), undefined)
  } finally { await scope.dispose() }
})

test('意图事件支持继续调用和短路，观察事件同步通知', async () => {
  const framework = await bootstrapAgents()
  const calls: string[] = []
  const version = FsVersion('v1')
  const scope = framework.context.plugin(ctx => {
    ctx.on('fs/write-intent', async (_target, _actor, next) => { calls.push('write'); return next() })
    ctx.on('fs/edit-intent', async () => { calls.push('edit'); return { version } })
    ctx.on('fs/delete-intent', async (_target, _actor, next) => { calls.push('delete'); return next() })
    ctx.on('fs/observed', () => { calls.push('observed') })
  })
  await scope
  try {
    assert.equal(await framework.context.waterfall('fs/write-intent', target, undefined, () => { calls.push('write-next'); return undefined }), undefined)
    assert.deepEqual(await framework.context.waterfall('fs/edit-intent', target, undefined, () => { calls.push('edit-next'); return undefined }), { version })
    assert.equal(await framework.context.waterfall('fs/delete-intent', target, undefined, () => { calls.push('delete-next'); return undefined }), undefined)
    framework.context.emit('fs/observed', target, { kind: 'absent' }, undefined)
    assert.deepEqual(calls, ['write', 'write-next', 'edit', 'delete', 'delete-next', 'observed'])
  } finally { await scope.dispose() }
  framework.context.emit('fs/observed', target, { kind: 'absent' }, undefined)
  assert.equal(calls.length, 6)
})

test('多个意图监听器依次委派，短路阻止后续监听器和默认处理', async () => {
  const framework = await bootstrapAgents()
  const calls: string[] = []
  const version = FsVersion('guard')
  const scope = framework.context.plugin(ctx => {
    ctx.on('fs/edit-intent', async (_target, _actor, next) => { calls.push('first'); return next() })
    ctx.on('fs/edit-intent', async () => { calls.push('guard'); return { version } })
    ctx.on('fs/edit-intent', async (_target, _actor, next) => { calls.push('last'); return next() })
  })
  await scope
  try {
    assert.deepEqual(await framework.context.waterfall('fs/edit-intent', target, undefined, () => { calls.push('default'); return undefined }), { version })
    assert.deepEqual(calls, ['first', 'guard'])
  } finally { await scope.dispose() }
  assert.equal(await framework.context.waterfall('fs/edit-intent', target, undefined, () => undefined), undefined)
})

test('观察事件传播同步异常，并在监听器作用域销毁后注销', async () => {
  const framework = await bootstrapAgents()
  const failure = new Error('观察失败')
  const scope = framework.context.plugin(ctx => {
    ctx.on('fs/observed', () => { throw failure })
  })
  await scope
  assert.throws(() => framework.context.emit('fs/observed', target, { kind: 'absent' }, undefined), error => error === failure)
  await scope.dispose()
  assert.doesNotThrow(() => framework.context.emit('fs/observed', target, { kind: 'absent' }, undefined))
})

test('文件事件共用 Cordis 总线，监听器随各自 Agent 作用域注销', async () => {
  const framework = await bootstrapAgents()
  const calls: string[] = []
  const observer = Object.assign((ctx: Context) => {
    const id = ctx.agent.id
    ctx.on('fs/observed', () => { calls.push(id) })
  }, { inject: ['agent'] })
  framework.plugins.register({ id: 'fs-observer-test', version: '1', plugin: observer })
  framework.presets.register({ id: 'fs-observer-test', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'fs-observer-test' }]) })
  try {
    const first = await createTestAgent(framework, { id: 'observer-a', presetId: 'fs-observer-test' })
    const second = await createTestAgent(framework, { id: 'observer-b', presetId: 'fs-observer-test' })
    first.context.emit('fs/observed', target, { kind: 'absent' }, undefined)
    assert.deepEqual(calls, ['observer-a', 'observer-b'])
    await framework.manager.dispose('observer-a')
    second.context.emit('fs/observed', target, { kind: 'absent' }, undefined)
    assert.deepEqual(calls, ['observer-a', 'observer-b', 'observer-b'])
  } finally { await framework.manager.disposeAll() }
})
