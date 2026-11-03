import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { bootstrapAgents } from '../../agents/core/bootstrap.js'

class SkillCallingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly selected: string) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: 'skill-call' as ToolCallId, name: 'skill', arguments: JSON.stringify({ name: this.selected }),
      } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已处理' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('Skill 从实例来源发布摘要、按需加载正文并记录 Session，其他 Agent 无法猜测加载', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'fly-skill-integration-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const world = join(base, 'world')
  const character = join(base, 'character')
  await mkdir(join(world, 'fantasy-world-planning'), { recursive: true })
  await mkdir(join(character, 'character-planning'), { recursive: true })
  await copyFile(resolve('src/agents/world-initialization-main-agent/skills/fantasy-world-planning/SKILL.md'), join(world, 'fantasy-world-planning', 'SKILL.md'))
  await writeFile(join(character, 'character-planning', 'SKILL.md'), '---\nname: character-planning\ndescription: 规划角色\n---\n角色专属指导')
  const framework = await bootstrapAgents()
  framework.presets.register({ id: 'skill-integration', version: '1', role: 'character', plugins: [
    { pluginId: 'agent-loop-runtime' }, { pluginId: 'session' }, { pluginId: 'system-prompt' },
    { pluginId: 'llm' }, { pluginId: 'tools' }, { pluginId: 'skills' },
    { pluginId: 'skill-filesystem' }, { pluginId: 'tool-skill' },
  ] })
  const worldAdapter = new SkillCallingAdapter('fantasy-world-planning')
  const otherAdapter = new SkillCallingAdapter('fantasy-world-planning')
  const create = (id: string, root: string, adapter: SkillCallingAdapter) => framework.manager.create({
    id, presetId: 'skill-integration', pluginConfigs: {
      'agent-loop-runtime': { provider: 'test', model: 'test', workingDirectory: base },
      'skill-filesystem': { root }, llm: { adapters: [{ providers: ['test'], adapter }] },
    },
  })
  try {
    const first = await create('world', world, worldAdapter)
    const second = await create('character', character, otherAdapter)
    assert.deepEqual(await first.run({ prompt: '规划世界' }), { content: '已处理' })
    assert.deepEqual(await second.run({ prompt: '规划角色' }), { content: '已处理' })
    assert.equal(worldAdapter.requests.length, 2)
    assert.ok(worldAdapter.requests[0]?.tools?.some(tool => tool.name === 'skill'))
    const initial = JSON.stringify(worldAdapter.requests[0]?.messages)
    assert.match(initial, /fantasy-world-planning/)
    assert.doesNotMatch(initial, /玄幻世界初始化规划|character-planning|角色专属指导/)
    const next = JSON.stringify(worldAdapter.requests[1]?.messages)
    assert.match(next, /<skill_content name=\\"fantasy-world-planning\\">/)
    assert.match(next, /玄幻世界初始化规划/)
    assert.doesNotMatch(next, /角色专属指导/)
    const otherInitial = JSON.stringify(otherAdapter.requests[0]?.messages)
    assert.match(otherInitial, /character-planning/)
    assert.doesNotMatch(otherInitial, /fantasy-world-planning|玄幻世界初始化规划/)
    const otherNext = JSON.stringify(otherAdapter.requests[1]?.messages)
    assert.match(otherNext, /不存在或不可用/)
    assert.doesNotMatch(otherNext, /玄幻世界初始化规划/)
    const events = first.context.sessions.list()[0]!.read()
    const call = events.find(event => event.type === 'tool/call')
    const result = events.find(event => event.type === 'tool/result')
    assert.ok(call && call.type === 'tool/call')
    assert.equal(call.data.name, 'skill')
    assert.ok(result && result.type === 'tool/result')
    assert.equal(result.data.message.source.callId, call.data.callId)
    assert.match(JSON.stringify(result.data.message), /玄幻世界初始化规划/)
    const skillService = first.context.skills
    await framework.manager.dispose('world')
    await assert.rejects(skillService.list(base, new AbortController().signal), /已关闭/)
    assert.equal((await second.context.skills.list(base, new AbortController().signal))[0]?.name, 'character-planning')
  } finally {
    await framework.manager.disposeAll()
  }
})
