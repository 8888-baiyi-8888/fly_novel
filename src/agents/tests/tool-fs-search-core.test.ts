import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { LocalSubprocessRuntime } from '@fly-novel/subprocess-local'
import { runSearch } from '@fly-novel/tool-fs-search'

test('受控执行使用实际打包 ripgrep，在读取根内搜索并拒绝根外目标', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, 'fly-search-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const work = join(dir, 'work'); const outside = join(dir, 'outside')
  await mkdir(work); await mkdir(outside)
  await writeFile(join(work, 'hello.txt'), 'alpha\n')
  await writeFile(join(outside, 'secret.txt'), 'secret\n')
  const ctx = new Context()
  const fs = ctx.plugin(LocalFileSystem, { cwd: work }); await fs
  const processes = ctx.plugin(LocalSubprocessRuntime); await processes
  t.after(async () => { await processes.dispose(); await fs.dispose() })
  const limits = { timeoutMs: 5000, graceMs: 100, rawOutputMaxBytes: 10000, stderrMaxBytes: 256 }
  const signal = new AbortController().signal
  const files = await runSearch(ctx, work, '.', ['--files', '--null'], limits, signal)
  assert.match(files.stdout, /hello\.txt\0/)
  assert.equal(files.noMatches, false)
  const none = await runSearch(ctx, work, '.', ['--json', '--regexp=no-match'], limits, signal)
  assert.equal(none.noMatches, true)
  await assert.rejects(runSearch(ctx, work, outside, ['--files'], limits, signal), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(runSearch(ctx, work, '.', ['--files'], { ...limits, rawOutputMaxBytes: 1 }, signal), /超过输出上限/)
  await assert.rejects(runSearch(ctx, work, '.', ['--json', '--regexp=['], limits, signal), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, '搜索模式无效')
    assert.doesNotMatch(error.message, /regex|outside|secret/i)
    return true
  })
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(runSearch(ctx, work, '.', ['--files'], limits, cancelled.signal), /搜索已取消/)
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const fake = t.mock.method(ctx.subprocess, 'spawn', (...[spec]: Parameters<typeof ctx.subprocess.spawn>) => {
    markStarted()
    const done = new Promise<{ exitCode: number | null, signal: NodeJS.Signals | null }>(resolve => {
      const finish = () => resolve({ exitCode: null, signal: 'SIGTERM' })
      if (spec.signal?.aborted) finish()
      else spec.signal?.addEventListener('abort', finish, { once: true })
    })
    const output = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
    return { done, collected: { stdout: output, stderr: output }, terminate() {}, async waitForExit() { return true } }
  })
  const running = new AbortController()
  const pending = runSearch(ctx, work, '.', ['--files'], limits, running.signal)
  await started
  running.abort()
  await assert.rejects(pending, /搜索已取消/)
  await assert.rejects(runSearch(ctx, work, '.', ['--files'], { ...limits, timeoutMs: 50 }, signal), /搜索超时/)
  fake.mock.restore()
})
