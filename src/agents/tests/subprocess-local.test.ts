import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@fly-novel/subprocess'
import { LocalSubprocessRuntime } from '@fly-novel/subprocess-local'

async function setup(t: TestContext) {
  const ctx = new Context()
  const scope = ctx.plugin(LocalSubprocessRuntime)
  await scope
  t.after(() => scope.dispose())
  return { service: ctx.subprocess, scope }
}

function spec(code: string, signal?: AbortSignal): SubprocessSpawnSpec {
  return { argv: [process.execPath, '-e', code], cwd: process.cwd(), stdio: { stdin: 'ignore', stdout: { maxBytes: 8 }, stderr: { maxBytes: 8 } }, graceMs: 100, signal }
}

test('执行参数不经过 Shell，输出保留上限与非零退出状态', async t => {
  const { service } = await setup(t)
  const request = spec('process.stdout.write(process.argv[1]); process.stderr.write("abcdefghijk"); process.exitCode = 7')
  request.argv = [...request.argv, 'a&b']
  const handle = service.spawn(request)
  assert.deepEqual(await handle.done, { exitCode: 7, signal: null })
  assert.equal(handle.collected.stdout.readFrom(0).text, 'a&b')
  assert.deepEqual(handle.collected.stderr.readFrom(0), { text: 'defghijk', nextOffset: 11, lossy: true })
  assert.equal(await handle.waitForExit(), true)
})

test('启动失败和已取消请求明确失败', async t => {
  const { service } = await setup(t)
  const request = spec('')
  request.argv = ['nonexistent-fly-subprocess-executable']
  await assert.rejects(service.spawn(request).done, { code: 'ENOENT' })
  const controller = new AbortController(); controller.abort()
  assert.throws(() => service.spawn(spec('', controller.signal)), { name: 'AbortError' })
  assert.throws(() => service.spawn({ ...spec(''), cwd: 'relative' }), /绝对路径/)
  assert.throws(() => service.spawn({ ...spec(''), graceMs: 0 }), /宽限期/)
})

test('子进程环境缺省过滤凭据且支持可信覆盖', async t => {
  const { service } = await setup(t)
  const original = process.env.FLY_TEST_PASSWORD
  process.env.FLY_TEST_PASSWORD = 'secret'
  try {
    const request = spec('process.stdout.write(process.env.FLY_TEST_PASSWORD ?? "none")')
    assert.equal((await (async () => { const h = service.spawn(request); await h.done; return h.collected.stdout.readFrom(0) })()).text, 'none')
    request.env = { FLY_TEST_PASSWORD: 'allowed' }
    const handle = service.spawn(request); await handle.done
    assert.equal(handle.collected.stdout.readFrom(0).text, 'allowed')
  } finally {
    if (original === undefined) delete process.env.FLY_TEST_PASSWORD
    else process.env.FLY_TEST_PASSWORD = original
  }
})

test('取消与作用域销毁等待已启动的直接进程退出', async t => {
  const { service, scope } = await setup(t)
  const controller = new AbortController()
  const first = service.spawn(spec('setInterval(() => {}, 1000)', controller.signal))
  controller.abort()
  await first.done
  assert.equal(await first.waitForExit(), true)
  const second = service.spawn(spec('setInterval(() => {}, 1000)'))
  await scope.dispose()
  await scope.dispose()
  await second.done
  assert.equal(await second.waitForExit(), true)
  assert.throws(() => service.spawn(spec('')), /已关闭/)
})
