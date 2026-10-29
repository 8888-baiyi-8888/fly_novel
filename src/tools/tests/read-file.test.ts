import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import type { ToolCallId } from '@fly-novel/llm'
import { readFileTool } from '../filesystem/read-file.js'

test('read_file 读取 UTF-8 文件并拒绝越界和无效文件', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'fly-novel-tool-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'workspace')
  await mkdir(root)
  await writeFile(join(root, 'outline.txt'), '第一章：启程')
  await writeFile(join(base, 'outside.txt'), 'private')
  const context = { callId: 'call-read' as ToolCallId, name: 'read_file', workingDirectory: root, signal: new AbortController().signal }
  const rootPath = await realpath(root)
  assert.equal(await readFileTool.execute({ path: 'outline.txt' }, context), '第一章：启程')
  assert.deepEqual(readFileTool.output.render({ path: 'outline.txt' }, '内容'), [{ type: 'text', text: '内容' }])
  assert.deepEqual(readFileTool.parameters, { type: 'object', properties: { path: { type: 'string', description: '相对于工作目录的文件路径' } }, required: ['path'] })
  await assert.rejects(readFileTool.execute({}, context), { name: 'ToolArgsError', code: 'INVALID_ARGS' })
  await assert.rejects(readFileTool.execute({ path: 123 }, context), { name: 'ToolArgsError', code: 'INVALID_ARGS' })
  await assert.rejects(readFileTool.execute({ path: 'outline.txt' }, { ...context, signal: AbortSignal.abort() }), { name: 'AbortError' })
  await assert.rejects(readFileTool.execute({ path: '../outside.txt' }, context), { message: `文件路径超出授权工作目录：${rootPath}` })
  await assert.rejects(readFileTool.execute({ path: resolve(root, 'outline.txt') }, context), /相对路径/)
  await assert.rejects(readFileTool.execute({ path: 'missing.txt' }, context), { code: 'ENOENT' })
  await assert.rejects(readFileTool.execute({ path: '.' }, context), /普通文件/)
  await writeFile(join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1))
  await assert.rejects(readFileTool.execute({ path: 'large.txt' }, context), /1 MiB/)
  await writeFile(join(root, 'invalid.txt'), Buffer.from([0xff]))
  await assert.rejects(readFileTool.execute({ path: 'invalid.txt' }, context))
})

test('read_file 拒绝指向授权目录外的符号链接', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'fly-novel-link-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'workspace')
  await mkdir(root)
  await writeFile(join(base, 'outside.txt'), 'private')
  try {
    await symlink(join(base, 'outside.txt'), join(root, 'link.txt'), 'file')
  } catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') {
      t.skip('Windows 当前用户没有创建符号链接的权限')
      return
    }
    throw error
  }
  const rootPath = await realpath(root)
  await assert.rejects(readFileTool.execute({ path: 'link.txt' }, { callId: 'call-link' as ToolCallId, name: 'read_file', workingDirectory: root, signal: new AbortController().signal }), { message: `文件路径超出授权工作目录：${rootPath}` })
})
