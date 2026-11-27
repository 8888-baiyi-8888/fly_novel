import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createStoryScene, listStoryScenes, readStory, readStoryScene, runStoryTree } from '../../app/story-workflow.js'
import { ScriptedAdapter, achieved, leaf, setup, simulation } from './fixtures.js'

test('场景设置归属同一个直接演绎故事，重读时按顺序返回', async t => {
  const { baseOptions, plan } = await setup(t, ['安排等候点', '商队夜间抵达'])
  assert.equal(plan.outcome.kind, 'planned')
  if (plan.outcome.kind !== 'planned') throw new Error('预期曲水城规划')
  const [otherStory, owner] = plan.outcome.events
  const cityGate = { order: 1, situation: '商队抵达已关闭的城门', preparation: '守卫与领队交涉入城请求' }
  const outside = { order: 2, situation: '商队暂留城外', preparation: '商队寻找不积水的等候点' }
  const stop = new Error('场景准备完毕，测试在演绎前停止')
  const adapter = new ScriptedAdapter([...leaf('等候点'), ...leaf('夜间城门'), achieved])
  await assert.rejects(runStoryTree({
    ...baseOptions, adapter,
    simulate: async ({ preparation }) => {
      if (preparation === '等候点') return simulation
      await createStoryScene(baseOptions, plan.id, owner!.id, outside)
      const attempts = await Promise.allSettled([
        createStoryScene(baseOptions, plan.id, owner!.id, cityGate),
        createStoryScene(baseOptions, plan.id, owner!.id, cityGate),
      ])
      assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1)
      const rejected = attempts.find(attempt => attempt.status === 'rejected')
      assert.match(String(rejected?.reason), /场景身份及顺序已占用/)
      throw stop
    },
  }, plan.id), error => error === stop)

  const scenes = await listStoryScenes(baseOptions, plan.id, owner!.id)
  assert.deepEqual(scenes.map(({ order, situation, preparation }) => ({ order, situation, preparation })), [cityGate, outside])
  assert.deepEqual(scenes.map(scene => scene.status), ['pending', 'pending'])
  const gate = scenes[0]!
  assert.notEqual(gate.sceneId, scenes[1]!.sceneId)
  assert.equal(gate.runId, plan.id)
  assert.equal(gate.storyId, owner!.id)
  assert.deepEqual(await readStoryScene(baseOptions, plan.id, owner!.id, gate.sceneId), gate)
  assert.deepEqual(await listStoryScenes(baseOptions, plan.id, otherStory!.id), [])
  await assert.rejects(readStoryScene(baseOptions, plan.id, otherStory!.id, gate.sceneId), /不属于指定的运行与故事/)

  const other = await setup(t, ['另一轮商队'])
  await runStoryTree({
    ...other.baseOptions, adapter: new ScriptedAdapter([...leaf('另一轮'), achieved]), simulate: async () => simulation,
  }, other.plan.id)
  await assert.rejects(createStoryScene(baseOptions, plan.id, other.eventId, cityGate), { code: 'ENOENT' })
  await assert.rejects(readStoryScene(other.baseOptions, other.plan.id, other.eventId, gate.sceneId), /不属于指定的运行与故事/)

  const root = await readStory(baseOptions, plan.id)
  await assert.rejects(createStoryScene(baseOptions, plan.id, root.node.storyId, cityGate), /须归属已确定直接演绎/)

  const outsidePath = join(baseOptions.collaborationRoot, `${scenes[1]!.sceneId}.setup.scene.json`)
  const original = await readFile(outsidePath, 'utf8')
  const duplicate = JSON.stringify({ ...scenes[1], status: undefined, sceneId: gate.sceneId })
  await writeFile(outsidePath, duplicate)
  await assert.rejects(listStoryScenes(baseOptions, plan.id, owner!.id), /场景记录身份不匹配/)
  assert.equal(await readFile(outsidePath, 'utf8'), duplicate)
  await writeFile(outsidePath, original)
  assert.deepEqual(await listStoryScenes(baseOptions, plan.id, owner!.id), scenes)
})
