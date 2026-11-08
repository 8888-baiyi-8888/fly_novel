import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateWorldInitializationWorkspace } from '../agents/world-initialization-workspace.js'
import { Context } from '@deepseek-ai/cordis'
import { sandboxPolicyPlugin } from '@fly-novel/sandbox-policy'
import { WorldInitializationDraftFileSystem } from '../agents/world-initialization-draft-fs.js'
import configured = require('../call-llm.js')
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { createWorldInitializationAgentWithWorkspace } from '../agents/index.js'

class FixedAdapter extends LlmAdapter {
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

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

test('显式工作区入口装配文件与委派工具，不注册旧的 read_file', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const raw = await mkdtemp(join(parent, 'fly-world-entry-'))
  t.after(() => rm(raw, { recursive: true, force: true }))
  const viewRoot = await realpath(raw); const draftRoot = join(viewRoot, 'draft'); const confirmedRoot = join(viewRoot, 'confirmed')
  await mkdir(draftRoot); await mkdir(confirmedRoot)
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new FixedAdapter() }))
  const agent = await createWorldInitializationAgentWithWorkspace({ viewRoot, draftRoot, confirmedRoot })
  try {
    const names = agent.context.tools.schemas().map(tool => tool.name)
    for (const name of ['read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'delegate']) assert.ok(names.includes(name), name)
    assert.ok(!names.includes('read_file'))
    assert.deepEqual(await agent.run({ prompt: '构想' }), { content: '完成' })
    const execute = async (name: string, args: object) => (await agent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'id' as ToolCallId, name, arguments: JSON.stringify(args) }], workingDirectory: viewRoot, session: agent.context.sessions.list()[0]!, signal: new AbortController().signal })).results[0]!.result
    assert.equal((await execute('skill', { name: 'fantasy-world-planning' })).isError, false)
    const outside = join(process.cwd(), 'src/agents/world-initialization-main-agent/skills/fantasy-world-planning/SKILL.md')
    assert.equal((await execute('read', { file_path: outside })).isError, true)
  } finally { await agent.dispose() }
})
