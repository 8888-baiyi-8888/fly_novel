import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { continueStoryTree, runStoryTree } from '../../app/story-workflow.js'
import { ScriptedAdapter, achieved, advance, leaf, setup, simulation, task } from './fixtures.js'

test('默认演绎五个最小故事，继续时使用新数量且不重复演绎', async t => {
  const events = Array.from({ length: 7 }, (_, i) => `事件${i + 1}`)
  const { baseOptions, plan } = await setup(t, events)
  const seen: string[] = []
  const simulate = async ({ preparation }: { preparation: string }) => { seen.push(preparation); return simulation }
  const start = await runStoryTree({ ...baseOptions, simulate, adapter: new ScriptedAdapter(events.slice(0, 5).flatMap(leaf)) }, plan.id)
  assert.equal(start.kind, 'paused')
  if (start.kind !== 'paused') throw new Error('预期暂停')
  assert.equal(start.completedCount, 5)
  assert.deepEqual(seen, events.slice(0, 5))
  const options = { ...baseOptions, simulate, limit: 2, adapter: new ScriptedAdapter([...events.slice(5).flatMap(leaf), achieved]) }
  const end = await continueStoryTree(options, plan.id, start.batch)
  assert.equal(end.kind, 'result')
  assert.equal(end.completedCount, 2)
  assert.equal(end.storyId, start.storyId)
  assert.deepEqual(seen, events)
  await assert.rejects(continueStoryTree(options, plan.id, start.batch), /已使用/)
})

test('暂停保留运行中的父故事，下次继续跨层推进', async t => {
  const { baseOptions, plan } = await setup(t)
  const seen: string[] = []
  const simulate = async ({ preparation }: { preparation: string }) => { seen.push(preparation); return simulation }
  const start = await runStoryTree({ ...baseOptions, limit: 1, simulate, adapter: new ScriptedAdapter([
    advance, task, '{"kind":"split","children":["核对身份","进行交涉"]}', ...leaf('核对身份'),
  ]) }, plan.id)
  assert.equal(start.kind, 'paused')
  if (start.kind !== 'paused') throw new Error('预期暂停')
  assert.equal(start.completedCount, 1)
  const adapter = new ScriptedAdapter([...leaf('进行交涉'), achieved, '收到城门故事回报', ...leaf('处理货物'), achieved])
  const end = await continueStoryTree({ ...baseOptions, limit: 2, simulate, adapter }, plan.id, start.batch)
  assert.equal(end.kind, 'result')
  assert.equal(end.completedCount, 2)
  assert.match(JSON.stringify(adapter.requests[0]?.messages), /守卫拒绝开门/)
  assert.deepEqual(seen, ['核对身份', '进行交涉', '处理货物'])
})

test('继续后演绎失败时不生成新的可继续位置', async t => {
  const { baseOptions, plan } = await setup(t)
  const start = await runStoryTree({ ...baseOptions, limit: 1, simulate: async () => simulation, adapter: new ScriptedAdapter(leaf('城门')) }, plan.id)
  if (start.kind !== 'paused') throw new Error('预期暂停')
  const options = { ...baseOptions, limit: 1, simulate: async () => { throw new Error('演绎失败') }, adapter: new ScriptedAdapter(leaf('货物')) }
  await assert.rejects(continueStoryTree(options, plan.id, start.batch), /演绎失败/)
  assert.equal((await readdir(baseOptions.collaborationRoot)).filter(file => file.endsWith('.paused.story.json')).length, 1)
  await assert.rejects(continueStoryTree(options, plan.id, start.batch), /已使用/)
})

test('继续时校验已保存结果，实际取消的演绎不计入完成', async t => {
  const { baseOptions, plan } = await setup(t)
  if (plan.outcome.kind !== 'planned') throw new Error('预期计划')
  const start = await runStoryTree({ ...baseOptions, limit: 1, simulate: async () => simulation, adapter: new ScriptedAdapter(leaf('城门')) }, plan.id)
  if (start.kind !== 'paused') throw new Error('预期暂停')
  const [first, second] = plan.outcome.events
  const path = join(baseOptions.collaborationRoot, `${plan.id}.${first!.id}.result.story.json`)
  const original = await readFile(path, 'utf8')
  await writeFile(path, original.replace('已接收', '结果已变化'))
  const controller = new AbortController()
  const adapter = new ScriptedAdapter(leaf('货物'))
  const options = { ...baseOptions, limit: 1, adapter, simulate: async () => { controller.abort(); return simulation } }
  await assert.rejects(continueStoryTree(options, plan.id, start.batch), /子故事结果不匹配/)
  assert.equal(adapter.requests.length, 0)
  await writeFile(path, original)
  await assert.rejects(continueStoryTree(options, plan.id, start.batch, controller.signal), { name: 'AbortError' })
  const files = await readdir(baseOptions.collaborationRoot)
  assert.equal(files.filter(file => file.endsWith('.paused.story.json')).length, 1)
  assert.ok(!files.includes(`${plan.id}.${second!.id}.result.story.json`))
})
