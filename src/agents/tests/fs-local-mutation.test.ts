import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { parsePatch } from '../plugins/fs/fs-patch/index.js'

// 行为参考 DeepSeek Harness fs-local 测试；版权及 MIT 许可见包内 LICENSE。
async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'fly-fs-write-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const scope = await ctx.plugin(LocalFileSystem, { cwd: dir })
  t.after(() => scope.dispose())
  return { dir, fs: ctx.fs as LocalFileSystem }
}

function patch(oldText = 'old', newText = 'new') {
  const [operation] = parsePatch(`*** Begin Patch\n*** Update File: file\n@@\n-${oldText}\n+${newText}\n*** End Patch`)
  if (operation?.kind !== 'update') throw new Error('补丁解析结果不是更新操作')
  return operation.hunks
}

function gate() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

test('Windows 1175 在文件未变化时有限重试并发布原暂存内容', async t => {
  const { dir, fs } = await setup(t)
  const path = join(dir, 'file'); await writeFile(path, 'old')
  const target = await fs.resolve('file'); const original = await fs.stat(target); assert.ok(original)
  fs.internals.platform = 'win32'; fs.internals.copyFileDacl = async () => {}
  let attempts = 0
  fs.internals.replaceFile = async (destination, source) => {
    attempts++
    if (attempts < 3) {
      await chmod(source, 0o400); await chmod(source, 0o600)
      throw Object.assign(new Error('simulated 1175'), { code: 'EIO', win32Code: 1175 })
    }
    await rename(source, destination)
  }
  await fs.writeText(target, 'new', { kind: 'replaceIfVersion', version: original.version })
  assert.equal(attempts, 3); assert.equal(await readFile(path, 'utf8'), 'new'); assert.deepEqual(await readdir(dir), ['file'])
})

test('Windows 1175 持续失败或其他错误时保留原文件', async t => {
  const { dir, fs } = await setup(t); const path = join(dir, 'file'); await writeFile(path, 'old')
  const target = await fs.resolve('file'); fs.internals.platform = 'win32'; fs.internals.copyFileDacl = async () => {}
  let attempts = 0
  fs.internals.replaceFile = async () => { attempts++; throw Object.assign(new Error('simulated 1175'), { code: 'EIO', win32Code: 1175 }) }
  await assert.rejects(fs.writeText(target, 'new'), { code: 'FS_IO_ERROR' }); assert.equal(attempts, 4)
  assert.equal(await readFile(path, 'utf8'), 'old'); assert.deepEqual(await readdir(dir), ['file'])
  attempts = 0
  fs.internals.replaceFile = async () => { attempts++; throw Object.assign(new Error('other failure'), { code: 'EIO', win32Code: 1176 }) }
  await assert.rejects(fs.writeText(target, 'new'), { code: 'FS_IO_ERROR' }); assert.equal(attempts, 1)
})

test('Windows 1175 重试前拒绝外部修改并响应取消', async t => {
  const { dir, fs } = await setup(t); const path = join(dir, 'file'); await writeFile(path, 'old')
  const target = await fs.resolve('file'); fs.internals.platform = 'win32'; fs.internals.copyFileDacl = async () => {}
  let attempts = 0
  fs.internals.replaceFile = async () => { attempts++; await writeFile(path, 'external change'); throw Object.assign(new Error('simulated 1175'), { code: 'EIO', win32Code: 1175 }) }
  await assert.rejects(fs.writeText(target, 'new'), { code: 'FS_STALE_VERSION' }); assert.equal(attempts, 1)
  assert.equal(await readFile(path, 'utf8'), 'external change')
  const abort = new AbortController(); attempts = 0
  fs.internals.replaceFile = async () => { attempts++; abort.abort(); throw Object.assign(new Error('simulated 1175'), { code: 'EIO', win32Code: 1175 }) }
  await assert.rejects(fs.writeText(target, 'new', undefined, abort.signal), { code: 'FS_ABORTED' }); assert.equal(attempts, 1)
  assert.equal(await readFile(path, 'utf8'), 'external change'); assert.deepEqual(await readdir(dir), ['file'])
})

test('Windows 1175 重试前拒绝变化的暂存内容', async t => {
  const { dir, fs } = await setup(t); const path = join(dir, 'file'); await writeFile(path, 'old')
  const target = await fs.resolve('file'); fs.internals.platform = 'win32'; fs.internals.copyFileDacl = async () => {}
  let attempts = 0
  fs.internals.replaceFile = async (_destination, staged) => { attempts++; await writeFile(staged, 'tampered'); throw Object.assign(new Error('simulated 1175'), { code: 'EIO', win32Code: 1175 }) }
  await assert.rejects(fs.writeText(target, 'new'), { code: 'FS_STALE_VERSION' }); assert.equal(attempts, 1)
  assert.equal(await readFile(path, 'utf8'), 'old'); assert.deepEqual(await readdir(dir), ['file'])
})

test('创建、覆盖与版本保护返回实际结果', async t => {
  const { dir, fs } = await setup(t)
  const target = await fs.resolve('file')
  const created = await fs.writeText(target, 'one\r\ntwo\r\n', { kind: 'createIfAbsent' })
  assert.equal(created.operation, 'create')
  assert.equal(created.before, null)
  assert.equal(created.after, 'one\ntwo\n')
  assert.equal(created.version, (await fs.stat(target))?.version)
  await assert.rejects(fs.writeText(target, 'bad', { kind: 'createIfAbsent' }), { code: 'FS_NOT_OBSERVED' })
  const changed = await fs.writeText(target, 'three\n', { kind: 'replaceIfVersion', version: created.version })
  assert.equal(changed.operation, 'update')
  assert.equal(changed.before, 'one\ntwo\n')
  assert.equal(changed.version, (await fs.stat(target))?.version)
  await assert.rejects(fs.writeText(target, 'bad', { kind: 'replaceIfVersion', version: created.version }), { code: 'FS_STALE_VERSION' })
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'three\n')
  await fs.writeText(target, 'unconditional')
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'unconditional')
  await assert.rejects(fs.writeText(await fs.resolve('missing'), 'bad', { kind: 'replaceIfVersion', version: changed.version }), { code: 'FS_STALE_VERSION' })
})

test('创建保护在暂存后仍拒绝外部竞争者并保留其内容', async t => {
  const { dir, fs } = await setup(t)
  const path = join(dir, 'race')
  const target = await fs.resolve('race')
  fs.internals.inspectTemp = async () => { await writeFile(path, 'competitor') }
  await assert.rejects(fs.writeText(target, 'ours', { kind: 'createIfAbsent' }), { code: 'FS_NOT_OBSERVED' })
  assert.equal(await readFile(path, 'utf8'), 'competitor')
  assert.deepEqual(await readdir(dir), ['race'])
})

test('覆盖差异基准的字节上限为排他上限', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fly-fs-bound-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const scope = await ctx.plugin(LocalFileSystem, { cwd: dir, diffBasisMaxBytes: 4 })
  t.after(() => scope.dispose())
  const fs = ctx.fs as LocalFileSystem
  const target = await fs.resolve('file')
  await writeFile(join(dir, 'file'), 'abc')
  assert.equal((await fs.writeText(target, 'xy')).before, 'abc')
  assert.equal((await fs.writeText(target, '中a')).before, null)
  assert.equal((await fs.writeText(target, 'ok')).before, null)
})

test('字面编辑、补丁与删除保留换行并检查失败', async t => {
  const { dir, fs } = await setup(t)
  for (const ending of ['\n', '\r\n']) {
    const name = ending === '\n' ? 'lf' : 'crlf'
    const path = join(dir, name)
    await writeFile(path, `old${ending}tail${ending}`)
    const target = await fs.resolve(name)
    const initial = await fs.stat(target)
    assert.ok(initial)
    const patched = await fs.patchText(target, patch(), { version: initial.version })
    assert.equal(patched.before, 'old\ntail\n')
    assert.equal(patched.after, 'new\ntail\n')
    assert.equal(patched.version, (await fs.stat(target))?.version)
    assert.equal(await readFile(path, 'utf8'), `new${ending}tail${ending}`)
    await assert.rejects(fs.patchText(target, patch(), { version: initial.version }), { code: 'FS_STALE_VERSION' })
    await assert.rejects(fs.patchText(target, patch()), { code: 'FS_PATCH_MISMATCH' })
    const edited = await fs.editText(target, { oldString: 'new', newString: 'again', replaceAll: false })
    assert.equal(edited.after, 'again\ntail\n')
    assert.equal(await readFile(path, 'utf8'), `again${ending}tail${ending}`)
    await assert.rejects(fs.editText(target, { oldString: 'missing', newString: 'x', replaceAll: false }), { code: 'FS_EDIT_NOT_FOUND' })
    const removed = await fs.deleteFile(target, { version: edited.version })
    assert.equal(removed.before, 'again\ntail\n')
    assert.equal(await fs.stat(target), undefined)
    await assert.rejects(fs.deleteFile(target), { code: 'FS_STALE_VERSION' })
  }
  await writeFile(join(dir, 'duplicate'), 'x x')
  await assert.rejects(fs.editText(await fs.resolve('duplicate'), { oldString: 'x', newString: 'y', replaceAll: false }), { code: 'FS_AMBIGUOUS_EDIT' })
  await mkdir(join(dir, 'folder'))
  const folder = await fs.resolve('folder')
  await assert.rejects(fs.writeText(folder, 'x'), { code: 'FS_NOT_REGULAR_FILE' })
  await assert.rejects(fs.patchText(folder, patch()), { code: 'FS_NOT_REGULAR_FILE' })
  await assert.rejects(fs.deleteFile(folder), { code: 'FS_NOT_REGULAR_FILE' })
})

test('移动先发布目标，源删除失败返回部分成功', async t => {
  const { dir, fs } = await setup(t)
  await writeFile(join(dir, 'source'), 'old\r\ntail\r\n')
  await writeFile(join(dir, 'destination'), 'prior\n')
  const source = await fs.resolve('source')
  const destination = await fs.resolve('destination')
  const before = await fs.stat(source)
  const destinationInfo = await fs.stat(destination)
  assert.ok(before)
  assert.ok(destinationInfo)
  await assert.rejects(fs.moveFile(source, destination, { expectedDestination: { kind: 'createIfAbsent' } }), { code: 'FS_NOT_OBSERVED' })
  await fs.writeText(destination, 'prior\n')
  await assert.rejects(fs.moveFile(source, destination, { expectedDestination: { kind: 'replaceIfVersion', version: destinationInfo.version } }), { code: 'FS_STALE_VERSION' })
  fs.internals.removeFile = async () => {
    assert.equal(await readFile(join(dir, 'destination'), 'utf8'), 'new\r\ntail\r\n')
    throw Object.assign(new Error('模拟删除失败'), { code: 'EACCES' })
  }
  const result = await fs.moveFile(source, destination, { hunks: patch(), expectedSource: { version: before.version } })
  assert.equal(result.sourceDeleted, false)
  if (!result.sourceDeleted) {
    assert.equal(result.sourceFailure.code, 'FS_PERMISSION_DENIED')
    assert.match(result.sourceFailure.message, /模拟删除失败/)
  }
  assert.equal(result.sourceBefore, 'old\ntail\n')
  assert.equal(result.destination.before, 'prior\n')
  assert.equal(result.destination.version, (await fs.stat(destination))?.version)
  assert.equal(await readFile(join(dir, 'source'), 'utf8'), 'old\r\ntail\r\n')
  delete fs.internals.removeFile
  await assert.rejects(fs.moveFile(source, source, {}), { code: 'FS_SAME_TARGET' })
  const moved = await fs.moveFile(source, await fs.resolve('new-destination'), { expectedSource: { version: before.version }, expectedDestination: { kind: 'createIfAbsent' } })
  assert.equal(moved.sourceDeleted, true)
  assert.equal(await fs.stat(source), undefined)
  assert.equal(await readFile(join(dir, 'new-destination'), 'utf8'), 'old\r\ntail\r\n')
})

test('同目标受控并发：版本竞争和失败后释放锁', { timeout: 10000 }, async t => {
  const { dir, fs } = await setup(t)
  await writeFile(join(dir, 'file'), 'original')
  const target = await fs.resolve('file')
  const info = await fs.stat(target)
  assert.ok(info)
  const entered = gate()
  const resume = gate()
  let calls = 0
  fs.internals.inspectTemp = async () => { if (++calls === 1) { entered.release(); await resume.wait } }
  const first = fs.writeText(target, 'first', { kind: 'replaceIfVersion', version: info.version })
  await entered.wait
  const second = fs.writeText(target, 'second', { kind: 'replaceIfVersion', version: info.version })
  resume.release()
  await first
  await assert.rejects(second, { code: 'FS_STALE_VERSION' })
  delete fs.internals.inspectTemp
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'first')
  await fs.writeText(target, 'after-failure')
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'after-failure')
})

test('相反方向移动按统一顺序加锁且不会死锁', { timeout: 10000 }, async t => {
  const { dir, fs } = await setup(t)
  await writeFile(join(dir, 'a'), 'A')
  await writeFile(join(dir, 'b'), 'B')
  const a = await fs.resolve('a')
  const b = await fs.resolve('b')
  const entered = gate()
  const resume = gate()
  let calls = 0
  fs.internals.inspectBeforeMutation = async () => { if (++calls === 1) { entered.release(); await resume.wait } }
  const first = fs.moveFile(a, b, {})
  await entered.wait
  const second = fs.moveFile(b, a, {})
  resume.release()
  assert.equal((await first).sourceDeleted, true)
  assert.equal((await second).sourceDeleted, true)
  assert.equal(await readFile(join(dir, 'a'), 'utf8'), 'A')
  assert.equal(await fs.stat(b), undefined)
})

test('取消、发布失败与提交后取消的内容和暂存清理', async t => {
  const { dir, fs } = await setup(t)
  const path = join(dir, 'file')
  await writeFile(path, 'before')
  const target = await fs.resolve('file')
  const controller = new AbortController()
  fs.internals.inspectTemp = () => { controller.abort() }
  await assert.rejects(fs.writeText(target, 'cancelled', undefined, controller.signal), { code: 'FS_ABORTED' })
  assert.equal(await readFile(path, 'utf8'), 'before')
  assert.deepEqual(await readdir(dir), ['file'])
  fs.internals.inspectTemp = () => { throw Object.assign(new Error('模拟暂存失败'), { code: 'EIO' }) }
  await assert.rejects(fs.writeText(target, 'failed'), { code: 'FS_IO_ERROR' })
  assert.equal(await readFile(path, 'utf8'), 'before')
  assert.deepEqual(await readdir(dir), ['file'])
  delete fs.internals.inspectTemp
  await writeFile(join(dir, 'source'), 'move')
  const source = await fs.resolve('source')
  const destination = await fs.resolve('destination')
  const moveAbort = new AbortController()
  fs.internals.inspectTemp = () => { moveAbort.abort() }
  const result = await fs.moveFile(source, destination, {}, moveAbort.signal)
  assert.equal(result.sourceDeleted, true)
  assert.equal(await readFile(join(dir, 'destination'), 'utf8'), 'move')
  assert.equal(await fs.stat(source), undefined)
  assert.deepEqual((await readdir(dir)).sort(), ['destination', 'file'])
})

test('移动和删除在最后检查点取消时不修改文件', async t => {
  const { dir, fs } = await setup(t)
  await writeFile(join(dir, 'source'), 'source')
  await writeFile(join(dir, 'destination'), 'destination')
  const source = await fs.resolve('source')
  const destination = await fs.resolve('destination')
  const moveAbort = new AbortController()
  fs.internals.inspectBeforeMutation = () => { moveAbort.abort() }
  await assert.rejects(fs.moveFile(source, destination, {}, moveAbort.signal), { code: 'FS_ABORTED' })
  assert.equal(await readFile(join(dir, 'source'), 'utf8'), 'source')
  assert.equal(await readFile(join(dir, 'destination'), 'utf8'), 'destination')
  const deleteAbort = new AbortController()
  fs.internals.inspectBeforeMutation = () => { deleteAbort.abort() }
  await assert.rejects(fs.deleteFile(source, undefined, deleteAbort.signal), { code: 'FS_ABORTED' })
  assert.equal(await readFile(join(dir, 'source'), 'utf8'), 'source')
  assert.deepEqual((await readdir(dir)).sort(), ['destination', 'source'])
})

test('创建发布失败清理暂存；提交后清理失败保留已发布结果', async t => {
  const { dir, fs } = await setup(t)
  const target = await fs.resolve('target')
  fs.internals.linkFile = async () => { throw Object.assign(new Error('模拟发布失败'), { code: 'EIO' }) }
  await assert.rejects(fs.writeText(target, 'failed', { kind: 'createIfAbsent' }), { code: 'FS_IO_ERROR' })
  assert.equal(await fs.stat(target), undefined)
  assert.deepEqual(await readdir(dir), [])
  delete fs.internals.linkFile
  fs.internals.tempDirName = () => 'known-stage'
  fs.internals.removeStagingDir = async () => { throw new Error('模拟清理失败') }
  const result = await fs.writeText(target, 'committed')
  assert.equal(result.operation, 'create')
  assert.equal(await readFile(join(dir, 'target'), 'utf8'), 'committed')
  assert.deepEqual((await readdir(dir)).sort(), ['known-stage', 'target'])
})

test('非 Windows 保留已有文件模式', async t => {
  if (process.platform === 'win32') return t.skip('Windows chmod 不提供 POSIX 文件模式语义')
  const { dir, fs } = await setup(t)
  const path = join(dir, 'file')
  await writeFile(path, 'before')
  await chmod(path, 0o640)
  await fs.writeText(await fs.resolve('file'), 'after')
  assert.equal((await stat(path)).mode & 0o777, 0o640)
})
