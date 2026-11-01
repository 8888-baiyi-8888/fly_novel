import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SkillService, type SkillDefinition, type SkillProvider } from '@fly-novel/skill'
import { FilesystemSkillProvider } from '@fly-novel/skill-filesystem'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

const signal = new AbortController().signal
const definition = (name: string, provider: string): SkillDefinition => ({
  name, description: '用途', provider, invocation: { modelInvocable: true, userInvocable: true },
  content: '正文', resourceBase: { kind: 'directory', path: '/example' },
})
const provider = (name: string, items: readonly SkillDefinition[]): SkillProvider => ({
  name,
  list: async () => items,
  get: async (item) => {
    const result = items.find(value => value.name === item)
    if (!result) throw new Error('不存在')
    return result
  },
})

test('服务注册来源，按名称查询，并拒绝重名与不完整结果', async () => {
  const service = new SkillService()
  const unregister = service.registerProvider(provider('one', [definition('alpha', 'one')]))
  assert.throws(() => service.registerProvider(provider('one', [])), /已注册/)
  const unregisterOther = service.registerProvider(provider('two', [definition('beta', 'two')]))
  assert.deepEqual((await service.list('.', signal)).map(item => item.name), ['alpha', 'beta'])
  assert.equal((await service.get('beta', '.', signal))?.content, '正文')
  assert.equal(await service.get('missing', '.', signal), undefined)
  unregisterOther()
  const conflict = service.registerProvider(provider('two', [definition('alpha', 'two')]))
  await assert.rejects(service.list('.', signal), /同名冲突/)
  conflict()
  const broken = service.registerProvider({ name: 'broken', list: async () => { throw new Error('读取失败') }, get: async () => definition('x', 'broken') })
  await assert.rejects(service.list('.', signal), /读取失败/)
  broken()
  unregister(); unregister()
  assert.deepEqual(await service.list('.', signal), [])
  service.dispose(); service.dispose()
  await assert.rejects(service.list('.', signal), /已关闭/)
})

test('查询期间注销来源不会返回过时结果', async () => {
  const service = new SkillService()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const unregister = service.registerProvider({ name: 'slow', list: async () => { await pending; return [] }, get: async () => definition('x', 'slow') })
  const query = service.list('.', signal)
  unregister()
  release()
  await assert.rejects(query, /发生变化/)
  service.dispose()
})

test('文件系统发现摘要、按需加载及检查文件和目录边界', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'fly-skill-list-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'skills')
  await mkdir(join(root, 'alpha'), { recursive: true })
  await mkdir(join(root, 'beta'))
  await mkdir(join(root, 'empty'))
  await writeFile(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 第一个\n---\n正文一')
  await writeFile(join(root, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: 第二个\ndisable-model-invocation: true\n---\n正文二')
  const service = new SkillService()
  service.registerProvider(new FilesystemSkillProvider(root))
  t.after(() => service.dispose())
  const summaries = await service.list(base, signal)
  assert.deepEqual(summaries.map(item => item.name), ['alpha', 'beta'])
  assert.equal(summaries[1]?.invocation.modelInvocable, false)
  assert.equal('content' in summaries[0]!, false)
  assert.equal((await service.get('alpha', base, signal))?.content, '正文一')
  await writeFile(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 第一个\n---\n更新正文')
  assert.equal((await service.get('alpha', base, signal))?.content, '更新正文')
  await writeFile(join(root, 'beta', 'SKILL.md'), 'invalid')
  await assert.rejects(service.list(base, signal), /frontmatter/)
  await rm(join(root, 'beta'), { recursive: true })
  const outside = await mkdtemp(join(tmpdir(), 'fly-skill-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(service.list(base, signal), /超出授权范围/)
})

test('Skill 插件在各 Agent 中装配并随 Agent 销毁清理', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'fly-skill-plugin-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'skills')
  await mkdir(join(root, 'alpha'), { recursive: true })
  await writeFile(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 用途\n---\n正文')
  const framework = await bootstrapAgents()
  try {
    assert.ok(framework.plugins.get('skills'))
    assert.ok(framework.plugins.get('skill-filesystem'))
    framework.presets.register({
      id: 'skill-plugin-test', version: '1', role: 'character',
      plugins: withAgentLoop([{ pluginId: 'skills' }, { pluginId: 'skill-filesystem' }]),
    })
    const pluginConfigs = { 'skill-filesystem': { root } }
    const first = await createTestAgent(framework, { id: 'skill-a', presetId: 'skill-plugin-test', pluginConfigs })
    const second = await createTestAgent(framework, { id: 'skill-b', presetId: 'skill-plugin-test', pluginConfigs })
    const skills = first.context.get('skills')
    const other = second.context.get('skills')
    assert.ok(skills)
    assert.ok(other)
    assert.notEqual(skills, other)
    assert.equal((await skills.get('alpha', base, signal))?.content, '正文')
    await framework.manager.dispose('skill-a')
    await assert.rejects(skills.list(base, signal), /已关闭/)
    assert.equal((await other.list(base, signal))[0]?.name, 'alpha')
  } finally {
    await framework.manager.disposeAll()
  }
})
