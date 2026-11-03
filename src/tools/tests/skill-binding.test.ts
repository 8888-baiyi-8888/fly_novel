import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ToolCallId } from '@fly-novel/llm'
import { SkillService } from '@fly-novel/skill'
import { ToolsService } from '@fly-novel/tools'
import { FilesystemSkillProvider } from '@fly-novel/skill-filesystem'
import { bootstrapAgents } from '../../agents/core/bootstrap.js'
import { createTestAgent, withAgentLoop } from '../../agents/tests/agent-loop-fixtures.js'

test('可信装配为不同 Agent 实例隔离来源与加载工具', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'fly-skill-binding-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const roots = ['world-a', 'world-b', 'character'].map(name => join(base, name))
  for (const [index, root] of roots.entries()) {
    await mkdir(join(root, 'common'), { recursive: true })
    await writeFile(join(root, 'common', 'SKILL.md'), `---\nname: common\ndescription: 共用名称\n---\n来源 ${index}`)
  }
  await mkdir(join(roots[0]!, 'world-only'))
  await writeFile(join(roots[0]!, 'world-only', 'SKILL.md'), '---\nname: world-only\ndescription: 世界专属\n---\n世界指导')
  await mkdir(join(roots[2]!, 'character-only'))
  await writeFile(join(roots[2]!, 'character-only', 'SKILL.md'), '---\nname: character-only\ndescription: 角色专属\n---\n角色指导')
  const framework = await bootstrapAgents()
  const bindings = withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'skills' }, { pluginId: 'skill-filesystem' }, { pluginId: 'tool-skill' }])
  framework.presets.register({ id: 'world-test', version: '1', role: 'character', plugins: bindings })
  framework.presets.register({ id: 'character-test', version: '1', role: 'character', plugins: bindings })
  try {
    const make = (id: string, presetId: string, root: string) => createTestAgent(framework, {
      id, presetId, pluginConfigs: { 'skill-filesystem': { root } },
    })
    const first = await make('world-a', 'world-test', roots[0]!)
    const second = await make('world-b', 'world-test', roots[1]!)
    const character = await make('character', 'character-test', roots[2]!)
    const firstSkills = first.context.get('skills')!
    const secondSkills = second.context.get('skills')!
    const characterSkills = character.context.get('skills')!
    assert.deepEqual((await firstSkills.list(base, new AbortController().signal)).map(item => item.name), ['common', 'world-only'])
    assert.deepEqual((await secondSkills.list(base, new AbortController().signal)).map(item => item.name), ['common'])
    assert.deepEqual((await characterSkills.list(base, new AbortController().signal)).map(item => item.name), ['character-only', 'common'])
    const firstTools = first.context.get('tools')!
    const secondTools = second.context.get('tools')!
    const characterTools = character.context.get('tools')!
    const call = async (tools: typeof firstTools, name: string, workingDirectory = base) => {
      const result = await tools.execute({
        calls: [{ type: 'tool-call', id: 'call' as ToolCallId, name: 'skill', arguments: JSON.stringify({ name }) }],
        signal: new AbortController().signal, workingDirectory,
      })
      assert.ok(result.results[0])
      return result.results[0].result
    }
    for (const [index, tools] of [firstTools, secondTools, characterTools].entries()) {
      const result = await call(tools, 'common')
      assert.ok(!result.isError)
      assert.match(JSON.stringify(result.value), new RegExp(`来源 ${index}`))
    }
    const guessed = await call(characterTools, 'world-only')
    assert.ok(guessed.isError)
    assert.match(guessed.error.message, /不存在或不可用/)
    const traversal = await call(characterTools, '../world-a/world-only')
    assert.ok(traversal.isError)
    assert.match(traversal.error.message, /名称/)
    const wrongWorkspace = await call(firstTools, 'common', roots[1])
    assert.ok(wrongWorkspace.isError)
    assert.match(wrongWorkspace.error.message, /超出授权工作目录/)
    await framework.manager.dispose('world-a')
    await assert.rejects(firstSkills.list(base, new AbortController().signal), /已关闭/)
    assert.throws(() => firstTools.get('skill'), /已销毁/)
    const stillAvailable = await call(secondTools, 'common')
    assert.ok(!stillAvailable.isError)
  } finally {
    await framework.manager.disposeAll()
  }
})

test('没有装配 Skill 和工具的 Agent 不继承根 Context 的注册', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fly-skill-root-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const framework = await bootstrapAgents()
  const rootSkills = new SkillService()
  const rootTools = new ToolsService()
  rootSkills.registerProvider(new FilesystemSkillProvider(root))
  framework.context.provide('skills', rootSkills)
  framework.context.provide('tools', rootTools)
  framework.presets.register({ id: 'no-skill-test', version: '1', role: 'character', plugins: withAgentLoop([]) })
  try {
    const agent = await createTestAgent(framework, { id: 'no-skill', presetId: 'no-skill-test' })
    assert.equal(agent.context.get('skills'), undefined)
    assert.equal(agent.context.get('tools'), undefined)
  } finally {
    await framework.manager.disposeAll()
    rootSkills.dispose()
    rootTools.dispose()
  }
})
