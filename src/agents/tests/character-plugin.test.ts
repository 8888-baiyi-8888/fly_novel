import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService } from '@fly-novel/tools'
import { CharacterRelationshipStore, CharacterStore, characterToolsPlugin } from '@fly-novel/character'

test('人物工具插件按可信配置注册并在作用域释放时注销', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'character-plugin-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const chars = join(root, 'characters'); const relations = join(root, 'relationships')
  await mkdir(chars); await mkdir(relations)
  const store = await CharacterStore.open(chars, true); t.after(() => store.close())
  const relationships = await CharacterRelationshipStore.open({ root: relations, worldId: 'world', phase: 'initialization', singleWriterProcess: true,
    resolvePerson: async id => ({ id, worldId: 'world' }) }); t.after(() => relationships.close())
  const tools = new ToolsService({ id: 'creator', name: '创建角色', role: 'general' }); t.after(() => tools.dispose())
  const context = new Context(); context.provide('tools', tools)
  const basic = await context.plugin(characterToolsPlugin, { store })
  assert.ok(tools.get('character_create')); assert.equal(tools.get('character_initialization_update'), undefined)
  assert.equal(tools.get('character_relationship_search'), undefined)
  await basic.dispose(); assert.equal(tools.get('character_create'), undefined)
  const all = await context.plugin(characterToolsPlugin, { store, initialization: true,
    relationship: { store: relationships, worldId: 'world', resolvePerson: async id => ({ id, worldId: 'world', name: '人物' }) } })
  assert.ok(tools.get('character_create')); assert.ok(tools.get('character_initialization_update')); assert.ok(tools.get('character_relationship_search'))
  await all.dispose(); assert.equal(tools.get('character_create'), undefined); assert.equal(tools.get('character_relationship_search'), undefined)
  assert.deepEqual(await store.query({}), [])
})
