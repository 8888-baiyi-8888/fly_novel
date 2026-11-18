import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { CharacterStore, parseCharacterRelationship } from '@fly-novel/character'
import { createCharacterCreator } from '../agents/character-creator.js'
import { loadConfiguredAdapter } from '../call-llm.js'

test('真实模型创建人物及初始化时已有关系', { skip: process.env.FLY_NOVEL_REAL_LLM_TEST !== '1', timeout: 240000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true })
  const resumeRoot = process.env.FLY_NOVEL_CHARACTER_REAL_RESUME_ROOT
  const root = await realpath(resumeRoot ?? await mkdtemp(join(tmp, 'character-real-'))); t.diagnostic(`独立测试目录：${root}`)
  const readRoot = join(root, 'world'); const characterRoot = join(readRoot, 'characters'); const sessionRoot = join(root, 'sessions')
  if (!resumeRoot) { await mkdir(characterRoot, { recursive: true }); await mkdir(sessionRoot) }
  const model = await loadConfiguredAdapter('deepseek')
  const agent = await createCharacterCreator({ worldId: 'character-real', agentId: 'creator', sessionId: 'real', sessionMode: resumeRoot ? 'resume' : 'create', sessionRoot,
    characterRoot, initializeCharacters: !resumeRoot, readRoot, defaultCharacterCount: 2, ...model })
  let response: string
  try {
    response = (await agent.run({ prompt: resumeRoot ? '继续' : '为开放修仙世界创建两位近期人物林岚和顾青。初始化时林岚是顾青的师父，顾青信任林岚；各有自己的目标，未来选择和结局不预设。请调用人物工具保存两位角色，并调用人物关系工具将已有的师徒关系和顾青对林岚的单向信任记录在同一份关系文件中。只创建这两个人物，不预设未来才发生的关系。最后报告成果和仍未确定的内容。' })).content
  } finally { await agent.dispose() }
  const store = await CharacterStore.open(characterRoot)
  try {
    const people = await store.query({}); const a = people.find(value => value.name === '林岚'); const b = people.find(value => value.name === '顾青')
    assert.ok(a && b, '未找到两位指定人物'); assert.equal(people.length, 2)
    assert.ok(people.every(value => value.contentStatus === 'suggested'))
    const relations = (await Promise.all((await readdir(join(characterRoot, 'relationships'))).filter(name => name.endsWith('.json')).map(name => readFile(join(characterRoot, 'relationships', name), 'utf8')))).map(parseCharacterRelationship)
    const relation = relations.find(value => value.participants.every(person => person.kind === 'linked') && value.participants.some(person => person.kind === 'linked' && person.id === a.id) && value.participants.some(person => person.kind === 'linked' && person.id === b.id))
    assert.ok(relation, '未找到两人的公共关系文件')
    assert.ok(relation.relations.some(item => /师|徒/.test(`${item.name}${item.description}`)), '缺少师徒关系')
    const side = relation.participants.findIndex(person => person.kind === 'linked' && person.id === b.id)
    assert.ok(relation.relations.some(item => /信任/.test(`${item.name}${item.description}`) && item.direction === (side === 0 ? 'a-to-b' : 'b-to-a')), '缺少顾青指向林岚的单向信任')
    assert.match(response, /林岚|顾青/)
    t.diagnostic(`人物 ${people.length}，关系文档 ${relations.length}；回复 ${response.length} 字`)
  } finally { await store.close() }
})
