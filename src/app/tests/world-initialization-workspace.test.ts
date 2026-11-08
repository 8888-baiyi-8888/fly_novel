import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateWorldInitializationWorkspace } from '../agents/world-initialization-workspace.js'

test('可信目录必须存在、位于同一视图且确认资料不在可写根内', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const raw = await mkdtemp(join(parent, 'fly-world-workspace-'))
  t.after(() => rm(raw, { recursive: true, force: true }))
  const root = await realpath(raw)
  const draftRoot = join(root, 'draft'); const confirmedRoot = join(root, 'confirmed')
  await mkdir(draftRoot); await mkdir(confirmedRoot)
  assert.deepEqual(await validateWorldInitializationWorkspace({ viewRoot: root, draftRoot, confirmedRoot }), { viewRoot: root, draftRoot, confirmedRoot })
  await assert.rejects(validateWorldInitializationWorkspace({ viewRoot: root, draftRoot: root, confirmedRoot }), /重叠/)
  await assert.rejects(validateWorldInitializationWorkspace({ viewRoot: draftRoot, draftRoot, confirmedRoot }), /视图内/)
  await assert.rejects(validateWorldInitializationWorkspace({ viewRoot: root, draftRoot, confirmedRoot: join(root, 'missing') }))
  const link = join(root, 'link')
  await symlink(confirmedRoot, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(validateWorldInitializationWorkspace({ viewRoot: root, draftRoot, confirmedRoot: link }), /真实路径/)
})

test('上游允许的系统临时目录不能作为已确认资料根', async t => {
  const raw = await mkdtemp(join(tmpdir(), 'fly-world-confirmed-'))
  t.after(() => rm(raw, { recursive: true, force: true }))
  const root = await realpath(raw)
  const draftRoot = join(root, 'draft'); const confirmedRoot = join(root, 'confirmed')
  await mkdir(draftRoot); await mkdir(confirmedRoot)
  await assert.rejects(validateWorldInitializationWorkspace({ viewRoot: root, draftRoot, confirmedRoot }), /重叠/)
})
