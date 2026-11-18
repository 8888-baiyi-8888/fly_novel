import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { CharacterStore } from '@fly-novel/character'
import { HistoryStore, historyEventSchema } from '@fly-novel/history'
import { characterAgentPreset } from '@fly-novel/agents'

test('角色初始化保留不同及错误的历史认知，修改世界历史不会覆盖角色认知', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'history-knowledge-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const charsRoot = join(root, 'characters'); const historyRoot = join(root, 'history')
  await mkdir(charsRoot); await mkdir(historyRoot); await mkdir(join(historyRoot, 'events')); await mkdir(join(historyRoot, 'candidates'))
  const chars = await CharacterStore.open(charsRoot, true); t.after(() => chars.close())
  const a = await chars.create({ name: '林岚', summary: '', categories: {}, body: '林岚认为战争由天灾引起。' })
  const b = await chars.create({ name: '顾青', summary: '', categories: {}, body: '顾青只知道水源争夺的公开说法。' })
  const beforeA = await readFile(join(charsRoot, a.id, 'profile.md'), 'utf8'); const beforeB = await readFile(join(charsRoot, b.id, 'profile.md'), 'utf8')
  const ctx = new Context(); const scope = await ctx.plugin(LocalFileSystem, { cwd: root }); t.after(() => scope.dispose())
  const history = await HistoryStore.open({ fs: ctx.fs, root: historyRoot, worldId: 'world', phase: 'initialization', access: 'read-write', singleWriterProcess: true }); t.after(() => history.close())
  const input = { name: '青河战争', aliases: [], detailLevel: 'overview' as const, summary: '', body: '', time: [], parents: [], childrenCoverage: 'unknown' as const,
    relations: [], references: [], publicAccounts: [{ content: '争夺水源', source: '公开记载' }], hidden: { state: 'known' as const, content: '商会推动战争' }, reserved: [] }
  const event = await history.create(input)
  assert.throws(() => historyEventSchema.parse({ ...( { ...input, formatVersion: 1, worldId: 'world', id: event.id, contentStatus: 'suggested' } ), knownBy: [a.id] }))
  await history.update(event.id, event.version, { ...input, hidden: { state: 'known', content: '幕后原因另待核查' } })
  assert.equal(await readFile(join(charsRoot, a.id, 'profile.md'), 'utf8'), beforeA)
  assert.equal(await readFile(join(charsRoot, b.id, 'profile.md'), 'utf8'), beforeB)
  assert.match((await chars.read(a.id)).body, /天灾/); assert.doesNotMatch((await chars.read(b.id)).body, /幕后原因/)
  assert.ok(!characterAgentPreset.plugins.some(plugin => plugin.pluginId === 'history-tools'))
})
