import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import type { ToolCallId } from '@fly-novel/llm'
import { ToolsService } from '@fly-novel/tools'
import { createSkillTool } from '../skill/skill.js'
import { readFileTool } from '../filesystem/read-file.js'
import { FilesystemSkillProvider } from '@fly-novel/skill-filesystem'
import { SkillService } from '@fly-novel/skill'

function createSkillToolForRoot(root: string) {
  const skills = new SkillService()
  skills.registerProvider(new FilesystemSkillProvider(root))
  return createSkillTool(skills)
}

test('通过 Tools 服务按名称加载世界初始化 Skill 并注销工具', async () => {
  const workspace = process.cwd()
  const root = resolve(workspace, 'src/agents/world-initialization-main-agent/skills')
  const tools = new ToolsService()
  const unregister = tools.register(createSkillToolForRoot(root))
  try {
    const [result] = (await tools.execute({
      calls: [{ type: 'tool-call', id: 'skill-1' as ToolCallId, name: 'skill', arguments: '{"name":"fantasy-world-planning"}' }],
      signal: new AbortController().signal,
      workingDirectory: workspace,
    })).results
    assert.ok(result && !result.result.isError)
    assert.equal(result.result.value !== null && typeof result.result.value === 'object' && !Array.isArray(result.result.value) && result.result.value.name, 'fantasy-world-planning')
    const text = result.result.content[0]
    assert.ok(text?.type === 'text')
    assert.match(text.text, /<skill_content name="fantasy-world-planning">/)
    assert.match(text.text, /玄幻世界初始化规划/)
    assert.doesNotMatch(text.text, /^description:/m)
    unregister()
    assert.equal(tools.get('skill'), undefined)
  } finally {
    tools.dispose()
  }
})

test('Skill 加载拒绝缺失、无效元信息、禁用模型调用和目录越界', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'fly-novel-skill-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const workspace = join(base, 'workspace')
  const root = join(workspace, 'skills')
  const outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside)
  const tools = new ToolsService()
  t.after(() => tools.dispose())
  tools.register(createSkillToolForRoot(root))
  async function call(name: string) {
    const result = await tools.execute({
      calls: [{ type: 'tool-call', id: 'call' as ToolCallId, name: 'skill', arguments: JSON.stringify({ name }) }],
      signal: new AbortController().signal,
      workingDirectory: workspace,
    })
    const item = result.results[0]?.result
    assert.ok(item?.isError)
    return item.error.message
  }

  assert.match(await call('../outside'), /名称/)
  assert.match(await call('missing'), /不存在或不可用/)
  await mkdir(join(root, 'invalid'))
  await writeFile(join(root, 'invalid', 'SKILL.md'), '---\nname: invalid\n---\n正文', 'utf8')
  assert.match(await call('invalid'), /description/)
  await writeFile(join(root, 'invalid', 'SKILL.md'), '---\nname: invalid\ndescription: test\ndisable-model-invocation: true\n---\n正文', 'utf8')
  assert.match(await call('invalid'), /不允许模型调用/)
  await writeFile(join(root, 'invalid', 'SKILL.md'), '---\nname: invalid\ndescription: test\ndisable-model-invocation: maybe\n---\n正文', 'utf8')
  assert.match(await call('invalid'), /布尔值/)
  await writeFile(join(root, 'invalid', 'SKILL.md'), '---\nname: invalid\ndescription: test\nuser-invocable: maybe\n---\n正文', 'utf8')
  assert.match(await call('invalid'), /布尔值/)
  await rm(join(root, 'invalid'), { recursive: true })
  await mkdir(join(root, 'unreadable', 'SKILL.md'), { recursive: true })
  assert.match(await call('unreadable'), /普通文件/)
  await rm(join(root, 'unreadable'), { recursive: true })
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.match(await call('escape'), /超出授权范围/)
  const unauthorized = new ToolsService()
  t.after(() => unauthorized.dispose())
  unauthorized.register(createSkillToolForRoot(outside))
  const result = await unauthorized.execute({
    calls: [{ type: 'tool-call', id: 'out' as ToolCallId, name: 'skill', arguments: '{"name":"invalid"}' }],
    signal: new AbortController().signal,
    workingDirectory: workspace,
  })
  assert.ok(result.results[0]?.result.isError)
  assert.match(result.results[0].result.error.message, /超出授权工作目录/)
})

test('Skill 工具调用在取消时不加载内容', async () => {
  const tools = new ToolsService()
  tools.register(createSkillToolForRoot(resolve('src/agents/world-initialization-main-agent/skills')))
  const controller = new AbortController()
  controller.abort()
  try {
    const result = await tools.execute({
      calls: [{ type: 'tool-call', id: 'cancel' as ToolCallId, name: 'skill', arguments: '{"name":"fantasy-world-planning"}' }],
      signal: controller.signal,
      workingDirectory: process.cwd(),
    })
    assert.ok(result.results[0]?.result.isError)
    assert.equal(result.results[0].result.error.info.code, 'ABORTED_BEFORE_DISPATCH')
  } finally {
    tools.dispose()
  }
})

test('Skill 资源由读取工具的工作目录独立授权', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'fly-skill-resources-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const workspace = join(base, 'workspace')
  const root = join(workspace, 'skills')
  const directory = join(root, 'example')
  await mkdir(join(directory, 'references'), { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), '---\nname: example\ndescription: 示例\n---\n参考 references/guide.md')
  await writeFile(join(directory, 'references', 'guide.md'), '授权的指导')
  await writeFile(join(workspace, 'other.txt'), '工作目录内的其他文件')
  await writeFile(join(base, 'outside.txt'), '工作目录外')
  const skill = await new FilesystemSkillProvider(root).get('example', workspace, new AbortController().signal)
  const context = { callId: 'resource' as ToolCallId, name: 'read_file', workingDirectory: skill.resourceBase.path, signal: new AbortController().signal }
  assert.equal(await readFileTool.execute({ path: 'references/guide.md' }, context), '授权的指导')
  await assert.rejects(readFileTool.execute({ path: '../../other.txt' }, context), /超出授权工作目录/)
  await assert.rejects(readFileTool.execute({ path: '../../../outside.txt' }, context), /超出授权工作目录/)
  const workspaceContext = { ...context, workingDirectory: workspace }
  assert.equal(await readFileTool.execute({ path: 'other.txt' }, workspaceContext), '工作目录内的其他文件')
})
