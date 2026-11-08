import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import test, { type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@fly-novel/fs-sandbox'
import { sandboxPolicyPlugin } from '@fly-novel/sandbox-policy'
import { parsePatch } from '../plugins/fs/fs-patch/index.js'

async function setup(t: TestContext, mode: 'read-only' | 'workspace-write' = 'workspace-write', grantOutside = false) {
  const parent = join(process.cwd(), 'tmp')
  await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, 'fly-sandbox-boundary-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const work = join(dir, 'work')
  const outside = join(dir, 'work-sibling')
  await mkdir(work); await mkdir(outside)
  const ctx = new Context()
  const policy = ctx.plugin(sandboxPolicyPlugin, { mode, workspaceRoot: await realpath(work), ...(grantOutside ? { additionalWritableRoots: [await realpath(outside)] } : {}) })
  await policy
  const scope = ctx.plugin(SandboxedFileSystem, { cwd: work })
  await scope
  t.after(async () => { await scope.dispose(); await policy.dispose() })
  return { dir, work, outside, fs: ctx.fs as SandboxedFileSystem }
}

function hunks() {
  const [op] = parsePatch('*** Begin Patch\n*** Update File: a\n@@\n-old\n+new\n*** End Patch')
  if (op?.kind !== 'update') throw new Error('补丁无效')
  return op.hunks
}

test('写入、编辑、补丁、删除在工作区内成功，根外逐项拒绝', async t => {
  const { fs, work, outside } = await setup(t)
  await writeFile(join(work, 'file'), 'old\n')
  await writeFile(join(outside, 'file'), 'old\n')
  const inside = await fs.resolve('file')
  const external = await fs.resolve(join(outside, 'file'))
  await assert.rejects(fs.writeText(external, 'bad'), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(fs.editText(external, { oldString: 'old', newString: 'bad', replaceAll: false }), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(fs.patchText(external, hunks()), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(fs.deleteFile(external), { code: 'FS_SANDBOX_DENIED' })
  assert.equal(await readFile(join(outside, 'file'), 'utf8'), 'old\n')
  await fs.patchText(inside, hunks())
  await fs.editText(inside, { oldString: 'new', newString: 'updated', replaceAll: false })
  await fs.writeText(inside, 'final')
  assert.equal(await readFile(join(work, 'file'), 'utf8'), 'final')
  await fs.deleteFile(inside)
  assert.equal(await fs.stat(inside), undefined)
})

test('移动检查源和目标，拒绝时保留两端内容', async t => {
  const { fs, work, outside } = await setup(t)
  await writeFile(join(work, 'a'), 'inside')
  await writeFile(join(outside, 'b'), 'outside')
  const a = await fs.resolve('a')
  const b = await fs.resolve(join(outside, 'b'))
  await assert.rejects(fs.moveFile(a, b, {}), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(fs.moveFile(b, a, {}), { code: 'FS_SANDBOX_DENIED' })
  assert.equal(await readFile(join(work, 'a'), 'utf8'), 'inside')
  assert.equal(await readFile(join(outside, 'b'), 'utf8'), 'outside')
  const c = await fs.resolve('c')
  assert.equal((await fs.moveFile(a, c, {})).sourceDeleted, true)
  assert.equal(await readFile(join(work, 'c'), 'utf8'), 'inside')
})

test('只读模式拒绝所有修改，但保留后端读取行为', async t => {
  const { fs, work } = await setup(t, 'read-only')
  await writeFile(join(work, 'file'), 'old\n')
  const file = await fs.resolve('file')
  const dest = await fs.resolve('dest')
  assert.equal(await fs.readText(file), 'old\n')
  await assert.rejects(fs.writeText(file, 'bad'), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(fs.editText(file, { oldString: 'old', newString: 'x', replaceAll: false }), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(fs.patchText(file, hunks()), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(fs.deleteFile(file), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(fs.moveFile(file, dest, {}), { code: 'FS_SANDBOX_DENIED' })
  assert.equal(await readFile(join(work, 'file'), 'utf8'), 'old\n')
})

test('绝对路径、父目录、相邻前缀和缺失祖先按最终目标判断', async t => {
  const { fs, work, outside } = await setup(t)
  await fs.writeText(await fs.resolve(join(work, 'absolute')), 'ok')
  await assert.rejects(fs.writeText(await fs.resolve(join(outside, 'missing', 'file')), 'bad'), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(fs.writeText(await fs.resolve(join('..', relative(join(work, '..'), outside), 'new')), 'bad'), { code: 'FS_SANDBOX_DENIED' })
  assert.equal(await readFile(join(work, 'absolute'), 'utf8'), 'ok')
})

test('目录链接指向工作区外时拒绝，包括检查前替换链接', async t => {
  const { fs, work, outside } = await setup(t)
  const link = join(work, 'link')
  try { await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) {
    if (error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) { t.skip(`平台无法创建目录链接：${String(error.code)}`); return }
    throw error
  }
  const target = await fs.resolve('link/new')
  await assert.rejects(fs.writeText(target, 'bad'), { code: 'FS_SANDBOX_DENIED' })
  await rm(link)
  await mkdir(link)
  const previouslyInside = await fs.resolve('link/file')
  await rm(link, { recursive: true })
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(fs.writeText(previouslyInside, 'bad'), { code: 'FS_SANDBOX_DENIED' })
  assert.equal(await fs.stat(await fs.resolve(join(outside, 'file'))), undefined)
})

test('上游平台临时根可写，未授权的仓库邻目录不因临时目录而放行', async t => {
  const { fs, outside } = await setup(t)
  const temp = await mkdtemp(join(tmpdir(), 'fly-sandbox-grant-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const target = await fs.resolve(join(temp, 'granted'))
  await fs.writeText(target, 'temp')
  assert.equal(await readFile(join(temp, 'granted'), 'utf8'), 'temp')
  await assert.rejects(fs.writeText(await fs.resolve(join(outside, 'denied')), 'x'), { code: 'FS_SANDBOX_DENIED' })
})

test('受信任配置显式附加目录后可写，缺省配置不包含该授权', async t => {
  const { fs, outside } = await setup(t, 'workspace-write', true)
  const target = await fs.resolve(join(outside, 'explicit'))
  await fs.writeText(target, 'granted')
  assert.equal(await readFile(join(outside, 'explicit'), 'utf8'), 'granted')
})

test('有效根内保持后端的过期版本和取消语义', async t => {
  const { fs, work } = await setup(t)
  await writeFile(join(work, 'file'), 'old')
  const target = await fs.resolve('file')
  const version = (await fs.stat(target))!.version
  await fs.writeText(target, 'newer')
  await assert.rejects(fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version }), { code: 'FS_STALE_VERSION' })
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(fs.writeText(target, 'cancelled', undefined, abort.signal), { code: 'FS_ABORTED' })
  assert.equal(await readFile(join(work, 'file'), 'utf8'), 'newer')
})

test('允许路径移动时保留后端源删除失败的部分成功语义', async t => {
  const { fs, work } = await setup(t)
  await writeFile(join(work, 'source'), 'content')
  const source = await fs.resolve('source')
  const destination = await fs.resolve('destination')
  fs.internals.removeFile = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
  t.after(() => { delete fs.internals.removeFile })
  const result = await fs.moveFile(source, destination, {})
  assert.equal(result.sourceDeleted, false)
  if (!result.sourceDeleted) assert.equal(result.sourceFailure.code, 'FS_PERMISSION_DENIED')
  assert.equal(await readFile(join(work, 'source'), 'utf8'), 'content')
  assert.equal(await readFile(join(work, 'destination'), 'utf8'), 'content')
})

test('作用域释放等待已开始的修改，释放后拒绝新修改', async t => {
  const parent = join(process.cwd(), 'tmp')
  await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, 'fly-sandbox-dispose-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const policy = ctx.plugin(sandboxPolicyPlugin, { mode: 'workspace-write', workspaceRoot: await realpath(dir) })
  await policy
  const scope = ctx.plugin(SandboxedFileSystem, { cwd: dir })
  await scope
  t.after(async () => { await scope.dispose(); await policy.dispose() })
  const fs = ctx.fs as SandboxedFileSystem
  let enter!: () => void; let resume!: () => void
  const started = new Promise<void>(resolve => { enter = resolve })
  const release = new Promise<void>(resolve => { resume = resolve })
  fs.internals.inspectTemp = async () => { enter(); await release }
  const target = await fs.resolve('file')
  const write = fs.writeText(target, 'committed')
  await started
  let closed = false
  const closing = scope.dispose().then(() => { closed = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(closed, false)
  resume()
  await write
  await closing
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'committed')
  await assert.rejects(fs.writeText(target, 'late'), /已销毁/)
})
