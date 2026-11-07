import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'

async function setup(t: TestContext): Promise<{ dir: string; fs: LocalFileSystem }> {
  const dir = await mkdtemp(join(tmpdir(), 'fly-fs-read-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const scope = await ctx.plugin(LocalFileSystem, { cwd: dir })
  t.after(() => scope.dispose())
  return { dir, fs: ctx.fs as LocalFileSystem }
}

async function collect(source: AsyncIterable<string>): Promise<string> {
  let result = ''
  for await (const chunk of source) result += chunk
  return result
}

test('路径基准、身份、宿主映射、URI 和包含关系', async t => {
  const { dir, fs } = await setup(t)
  await mkdir(join(dir, 'sub'))
  await writeFile(join(dir, 'sub', 'a #.txt'), 'text')
  const absolute = join(dir, 'sub', 'a #.txt')
  const target = await fs.resolve('sub/../sub/a #.txt')
  const alias = await fs.resolve(absolute)
  const fromCwd = await fs.resolve('a #.txt', { cwd: join(dir, 'sub') })
  assert.equal(target.targetKey, alias.targetKey)
  assert.equal(target.targetKey, fromCwd.targetKey)
  assert.equal(fs.processPath(target), await realpath(absolute))
  assert.equal(fs.fileUrl(target), pathToFileURL(await realpath(absolute)).href)
  assert.equal(fs.processPathFromHostPath(absolute), absolute)
  assert.equal(fs.processPathFromHostPath('relative'), undefined)
  const root = await fs.resolve('.')
  assert.equal(fs.contains(root, root), true)
  assert.equal(fs.contains(root, target), true)
  assert.equal(fs.contains(await fs.resolve('sub'), await fs.resolve('sibling')), false)
  const outside = await fs.resolve('..')
  assert.equal(fs.processPath(outside), await realpath(dirname(dir)))
  assert.equal(fs.contains(root, outside), false)
  const missing = await fs.resolve('sub/missing/child')
  assert.equal(await fs.stat(missing), undefined)
  assert.equal(await fs.lstat('sub/missing/child'), undefined)
})

test('目录链接解析、身份及最终分量 lstat', async t => {
  const { dir, fs } = await setup(t)
  await mkdir(join(dir, 'real'))
  await writeFile(join(dir, 'real', 'file.txt'), 'hello')
  try {
    await symlink(join(dir, 'real'), join(dir, 'dir-link'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP')) {
      t.skip(`平台或账户无法创建符号链接: ${String(error.code)}`)
      return
    }
    throw error
  }
  assert.equal((await fs.lstat('dir-link'))?.type, 'symlink')
  assert.equal((await fs.stat(await fs.resolve('dir-link')))?.type, 'directory')
  assert.equal((await fs.resolve('real/file.txt')).targetKey, (await fs.resolve('dir-link/file.txt')).targetKey)
  assert.equal((await fs.resolve('dir-link/new.txt')).targetKey, (await fs.resolve('real/new.txt')).targetKey)
})

test('文件符号链接解析和最终分量 lstat', async t => {
  const { dir, fs } = await setup(t)
  await writeFile(join(dir, 'file'), 'hello')
  try {
    await symlink(join(dir, 'file'), join(dir, 'link'), 'file')
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP')) {
      t.skip(`平台或账户无法创建文件符号链接: ${String(error.code)}`)
      return
    }
    throw error
  }
  assert.equal((await fs.lstat('link'))?.type, 'symlink')
  assert.equal((await fs.stat(await fs.resolve('link')))?.type, 'file')
  assert.equal((await fs.resolve('link')).targetKey, (await fs.resolve('file')).targetKey)
})

test('元数据和单层列表稳定排序，不读取文件正文', async t => {
  const { dir, fs } = await setup(t)
  await mkdir(join(dir, 'folder'))
  await writeFile(join(dir, 'z.bin'), Buffer.from([0, 255]))
  await writeFile(join(dir, 'a.txt'), 'hello')
  const file = await fs.resolve('a.txt')
  assert.deepEqual({ type: (await fs.stat(file))?.type, size: (await fs.stat(file))?.size }, { type: 'file', size: 5 })
  assert.equal((await fs.stat(await fs.resolve('folder')))?.type, 'directory')
  const entries = await fs.listDir(await fs.resolve('.'))
  assert.deepEqual(entries.map(entry => entry.name), ['a.txt', 'folder', 'z.bin'])
  assert.deepEqual(entries.map(entry => entry.type), ['file', 'directory', 'file'])
  assert.equal(entries[0].target.targetKey, file.targetKey)
  await assert.rejects(fs.readText(await fs.resolve('z.bin')), { code: 'FS_NOT_TEXT' })
  await assert.rejects(fs.listDir(file), { code: 'FS_NOT_DIRECTORY' })
  await assert.rejects(fs.listDir(await fs.resolve('absent')), { code: 'FS_NOT_FOUND' })
})

test('完整和分块 UTF-8、二进制检测和字节窗口', async t => {
  const { dir, fs } = await setup(t)
  const text = `${'a'.repeat(65535)}中\r\n尾\n`
  await writeFile(join(dir, 'text'), text)
  const target = await fs.resolve('text')
  assert.equal(await fs.readText(target), text)
  const chunks: string[] = []
  for await (const chunk of await fs.streamText(target)) chunks.push(chunk)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.length >= 2)
  assert.equal(chunks[0], 'a'.repeat(65535))
  const bytes = Buffer.from(text)
  assert.deepEqual(Buffer.from(await fs.readBytes(target, undefined, bytes.length)), bytes)
  await assert.rejects(fs.readBytes(target, undefined, bytes.length - 1), { code: 'FS_TOO_LARGE' })
  assert.deepEqual(Buffer.from(await fs.readByteRange(target, { offset: bytes.length - 2, length: 10 })), bytes.subarray(-2))
  assert.equal((await fs.readByteRange(target, { offset: bytes.length + 1, length: 4 })).length, 0)
  assert.equal((await fs.readByteRange(target, { offset: 0, length: 0 })).length, 0)
  for (const [name, data] of [['nul', Buffer.from([65, 0, 66])], ['invalid', Buffer.from([0xc3, 0x28])]] as const) {
    await writeFile(join(dir, name), data)
    const bad = await fs.resolve(name)
    await assert.rejects(fs.readText(bad), { code: 'FS_NOT_TEXT' })
    await assert.rejects(collect(await fs.streamText(bad)), { code: 'FS_NOT_TEXT' })
    assert.deepEqual(Buffer.from(await fs.readBytes(bad, undefined, data.length)), data)
  }
  await writeFile(join(dir, 'late-nul'), Buffer.concat([Buffer.alloc(8192, 65), Buffer.from([0])]))
  assert.equal((await fs.readText(await fs.resolve('late-nul'))).endsWith('\0'), true)
})

test('文件增长超限、取消和流关闭后释放文件', async t => {
  const { dir, fs } = await setup(t)
  const path = join(dir, 'file')
  await writeFile(path, '1234')
  const target = await fs.resolve('file')
  fs.internals.inspectReadBytesAfterStat = async () => { await writeFile(path, '12345') }
  await assert.rejects(fs.readBytes(target, undefined, 4), { code: 'FS_TOO_LARGE' })
  delete fs.internals.inspectReadBytesAfterStat
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(fs.resolve('file', { signal: controller.signal }), { code: 'FS_ABORTED' })
  await assert.rejects(fs.readText(target, controller.signal), { code: 'FS_ABORTED' })
  await assert.rejects(fs.readBytes(target, controller.signal, 5), { code: 'FS_ABORTED' })
  await assert.rejects(collect(await fs.streamText(target, controller.signal)), { code: 'FS_ABORTED' })
  await assert.rejects(fs.readText(await fs.resolve('missing')), { code: 'FS_NOT_FOUND' })
  await assert.rejects(fs.readText(await fs.resolve('.')), { code: 'FS_NOT_REGULAR_FILE' })
  const stream = await fs.streamText(target)
  for await (const _chunk of stream) break
  await rename(path, join(dir, 'renamed'))
  assert.equal(await fs.readText(await fs.resolve('renamed')), '12345')
})

test('读取中取消和 stat 后文件消失时释放流并传播错误', async t => {
  const { dir, fs } = await setup(t)
  const path = join(dir, 'large')
  await writeFile(path, 'x'.repeat(200000))
  const target = await fs.resolve('large')
  const controller = new AbortController()
  const iterator = (await fs.streamText(target, controller.signal))[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).done, false)
  controller.abort()
  await assert.rejects(iterator.next(), { code: 'FS_ABORTED' })
  await rename(path, join(dir, 'after-abort'))
  const renamed = await fs.resolve('after-abort')
  fs.internals.inspectReadBytesAfterStat = async () => { await rm(join(dir, 'after-abort')) }
  await assert.rejects(fs.readBytes(renamed, undefined, 200000), { code: 'ENOENT' })
  delete fs.internals.inspectReadBytesAfterStat
})

test('权限拒绝的真实文件用例', t => {
  if (process.platform === 'win32') {
    t.skip('Windows chmod 不能可靠制造当前账户的读取权限拒绝；需要受控 ACL 测试环境')
    return
  }
  t.skip('当前环境未配置可可靠制造权限拒绝的非特权测试账户')
})
