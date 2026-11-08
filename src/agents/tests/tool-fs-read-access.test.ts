import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { resolveReadTarget } from '@fly-novel/tool-fs'

test('读取目标限制到可信根，允许根内缺失路径并拒绝邻目录', async t => {
  await mkdir(join(process.cwd(), 'tmp'), { recursive: true })
  const dir = await mkdtemp(join(process.cwd(), 'tmp', 'fly-read-grant-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'root'); const outside = join(dir, 'root-other')
  await mkdir(root); await mkdir(outside)
  await writeFile(join(root, 'file'), 'text')
  const ctx = new Context(); const scope = ctx.plugin(LocalFileSystem, { cwd: dir }); await scope
  t.after(() => scope.dispose())
  const fs = ctx.fs as LocalFileSystem; const signal = new AbortController().signal
  const file = await resolveReadTarget(fs, 'root', 'file', signal)
  assert.equal(file.targetKey, (await fs.resolve(join(root, 'file'))).targetKey)
  const missing = await resolveReadTarget(fs, root, 'missing/child', signal)
  assert.equal(await fs.stat(missing), undefined)
  await assert.rejects(resolveReadTarget(fs, root, join(outside, 'file'), signal), { code: 'FS_PERMISSION_DENIED', message: '文件路径超出读取授权范围' })
  await assert.rejects(resolveReadTarget(fs, root, '../root-other/file', signal), { code: 'FS_PERMISSION_DENIED' })
  await assert.rejects(resolveReadTarget(fs, join(dir, 'missing'), 'file', signal), /授权目录/)
})

test('根内目录链接指向外部时禁止读取目标解析', async t => {
  await mkdir(join(process.cwd(), 'tmp'), { recursive: true })
  const dir = await mkdtemp(join(process.cwd(), 'tmp', 'fly-read-link-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'root'); const outside = join(dir, 'outside')
  await mkdir(root); await mkdir(outside)
  try { await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) {
    if (error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) { t.skip(`平台无法创建目录链接：${String(error.code)}`); return }
    throw error
  }
  const ctx = new Context(); const scope = ctx.plugin(LocalFileSystem, { cwd: dir }); await scope
  t.after(() => scope.dispose())
  const fs = ctx.fs as LocalFileSystem
  await assert.rejects(resolveReadTarget(fs, await realpath(root), 'link/missing', new AbortController().signal), { code: 'FS_PERMISSION_DENIED' })
})
