import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateWorldInitializationWorkspace } from '../agents/world-initialization-workspace.js'
import { Context } from '@deepseek-ai/cordis'
import { sandboxPolicyPlugin } from '@fly-novel/sandbox-policy'
import { WorldInitializationDraftFileSystem } from '../agents/world-initialization-draft-fs.js'

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

test('草稿文件后端额外拒绝修改已确认目录和上游允许的系统临时根', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const raw = await mkdtemp(join(parent, 'fly-draft-fs-'))
  t.after(() => rm(raw, { recursive: true, force: true }))
  const root = await realpath(raw)
  const draftRoot = join(root, 'draft'); const confirmedRoot = join(root, 'confirmed')
  await mkdir(draftRoot); await mkdir(confirmedRoot)
  const temporary = await mkdtemp(join(tmpdir(), 'fly-draft-denied-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const ctx = new Context()
  const policy = ctx.plugin(sandboxPolicyPlugin, { mode: 'workspace-write', workspaceRoot: draftRoot }); await policy
  const config = { cwd: root, draftRoot }
  const scope = ctx.plugin(WorldInitializationDraftFileSystem, config); await scope
  t.after(async () => { await scope.dispose(); await policy.dispose() })
  await ctx.fs.writeText(await ctx.fs.resolve(join(draftRoot, 'draft.txt')), 'draft')
  await assert.rejects(ctx.fs.writeText(await ctx.fs.resolve(join(confirmedRoot, 'fact.txt')), 'bad'), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(ctx.fs.writeText(await ctx.fs.resolve(join(temporary, 'bad.txt')), 'bad'), { code: 'FS_SANDBOX_DENIED' })
})

test('上游允许的系统临时目录不能作为已确认资料根', async t => {
  const raw = await mkdtemp(join(tmpdir(), 'fly-world-confirmed-'))
  t.after(() => rm(raw, { recursive: true, force: true }))
  const root = await realpath(raw)
  const draftRoot = join(root, 'draft'); const confirmedRoot = join(root, 'confirmed')
  await mkdir(draftRoot); await mkdir(confirmedRoot)
  await assert.rejects(validateWorldInitializationWorkspace({ viewRoot: root, draftRoot, confirmedRoot }), /重叠/)
})
