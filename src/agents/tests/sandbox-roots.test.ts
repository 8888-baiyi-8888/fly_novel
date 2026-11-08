import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { canonicalPath, SandboxInvalidRootError, workspaceWritableRoots, writableRoots } from '@fly-novel/sandbox'

// 可写根行为参考 DeepSeek Harness sandbox 测试；MIT 许可见对应包 LICENSE。
test('文件模式决定工作区、附加根和平台临时根', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fly-sandbox-roots-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = await realpath(directory)
  const extra = join(workspace, 'extra')
  await mkdir(extra)
  const policy = { mode: 'workspace-write' as const, workspaceRoot: workspace, additionalWritableRoots: [extra, extra] }
  assert.deepEqual(workspaceWritableRoots(policy), [canonicalPath(workspace), canonicalPath(extra)])
  const roots = writableRoots(policy)
  assert.ok(roots.includes(canonicalPath(tmpdir())))
  assert.ok(roots.includes(canonicalPath('/tmp')))
  assert.equal(new Set(roots).size, roots.length)
  assert.deepEqual(writableRoots({ ...policy, mode: 'read-only' }), [])
  assert.deepEqual(writableRoots({ ...policy, mode: 'danger-full-access' }), [])
})

test('附加根不存在或不是目录时明确拒绝', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fly-sandbox-invalid-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'file')
  await writeFile(file, 'data')
  for (const root of [file, join(directory, 'missing')]) {
    assert.throws(() => workspaceWritableRoots({ mode: 'workspace-write', workspaceRoot: resolve(directory), additionalWritableRoots: [root] }),
      (error: unknown) => error instanceof SandboxInvalidRootError && error.code === 'SANDBOX_INVALID_ROOT')
  }
})
