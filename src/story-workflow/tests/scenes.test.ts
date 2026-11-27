import assert from 'node:assert/strict'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { continueStoryTree, createStoryScene, listStoryScenes, readStory, readStoryScene, runStoryTree } from '../../app/story-workflow.js'
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

test('曲水城两段模拟各自落盘，子故事回报及暂停可重读其场景引用', async t => {
  const { baseOptions, plan, eventId } = await setup(t)
  const responses = leaf('夜间城门')
  const adapter = new ScriptedAdapter(responses)
  const gateSimulation = { ...simulation, summary: '守卫拒绝开门，商队退出入口' }
  const outsideSimulation = { ...simulation, summary: '商队转至高处，暂缓卸货' }
  const paused = await runStoryTree({
    ...baseOptions, adapter, limit: 1,
    simulate: async ({ recordSceneResult }) => {
      const gate = await createStoryScene(baseOptions, plan.id, eventId, {
        order: 1, situation: '夜间抵达城门', preparation: '守卫与领队核对入城事由',
      })
      assert.equal((await readStoryScene(baseOptions, plan.id, eventId, gate.sceneId)).status, 'pending')
      await recordSceneResult(gate.sceneId, { status: 'completed', simulation: gateSimulation })
      await assert.rejects(recordSceneResult(gate.sceneId, { status: 'terminated', simulation: outsideSimulation }), /结果已存在/)
      const savedGate = await readStoryScene(baseOptions, plan.id, eventId, gate.sceneId)
      assert.equal('result' in savedGate && savedGate.result.simulation.summary, gateSimulation.summary)
      assert.equal((await readStory(baseOptions, plan.id, eventId)).result, undefined)

      const outside = await createStoryScene(baseOptions, plan.id, eventId, {
        order: 2, situation: '商队暂留城外', preparation: '寻找适合临时安置货物的地点',
      })
      const other = await setup(t)
      const foreignId = `${other.plan.id}.${other.eventId}.1`
      await assert.rejects(recordSceneResult(foreignId, { status: 'completed', simulation }), /不属于指定的运行与故事/)
      const sibling = await readStory(baseOptions, plan.id)
      const siblingSceneId = `${plan.id}.${sibling.children[1]!.id}.1`
      await assert.rejects(recordSceneResult(siblingSceneId, { status: 'completed', simulation }), /不属于指定的运行与故事/)
      await recordSceneResult(outside.sceneId, { status: 'terminated', simulation: outsideSimulation })
      return simulation
    },
  }, plan.id)
  assert.equal(paused.kind, 'paused')
  assert.equal(paused.completedCount, 1)
  const story = await readStory(baseOptions, plan.id, eventId)
  assert.equal(story.result?.formatVersion, 2)
  if (story.result?.formatVersion !== 2) throw new Error('预期场景回报')
  const scenes = await Promise.all(story.result.sceneIds.map(id => readStoryScene(baseOptions, plan.id, eventId, id)))
  assert.deepEqual(scenes.map(scene => scene.status), ['completed', 'terminated'])
  assert.deepEqual(scenes.map(scene => 'result' in scene && scene.result.simulation), [gateSimulation, outsideSimulation])
  const reportRequest = JSON.stringify(adapter.requests[3]?.messages)
  assert.match(reportRequest, /守卫拒绝开门，商队退出入口/)
  assert.match(reportRequest, /商队转至高处，暂缓卸货/)
  await assert.rejects(createStoryScene(baseOptions, plan.id, eventId, {
    order: 3, situation: '等待天亮', preparation: '清点货物',
  }), /不能追加场景/)
  if (paused.kind !== 'paused') throw new Error('预期暂停')
  const snapshot = JSON.parse(await readFile(join(baseOptions.collaborationRoot, `${plan.id}.${paused.batch}.paused.story.json`), 'utf8'))
  assert.equal(snapshot.formatVersion, 2)
  const sceneResultPath = join(baseOptions.collaborationRoot, `${scenes[1]!.sceneId}.result.scene.json`)
  await rename(sceneResultPath, `${sceneResultPath}.bak`)
  await assert.rejects(readStory(baseOptions, plan.id, eventId), /场景尚未结算/)
  assert.equal((await readStoryScene(baseOptions, plan.id, eventId, scenes[0]!.sceneId)).status, 'completed')
  await rename(`${sceneResultPath}.bak`, sceneResultPath)
  const ended = await continueStoryTree({
    ...baseOptions, adapter: new ScriptedAdapter([...leaf('处理货物'), achieved]), simulate: async () => simulation,
  }, plan.id, paused.batch)
  assert.equal(ended.kind, 'result')
  assert.equal(ended.completedCount, 1)
})

test('待演绎、未决或导演回报失败时保留已有场景记录', async t => {
  for (const status of ['pending', 'unresolved', 'completed'] as const) {
    const { baseOptions, plan, eventId } = await setup(t)
    const adapter = new ScriptedAdapter([...leaf('夜间城门').slice(0, 3), '无效回报'])
    await assert.rejects(runStoryTree({
      ...baseOptions, adapter,
      simulate: async ({ recordSceneResult }) => {
        const scene = await createStoryScene(baseOptions, plan.id, eventId, {
          order: 1, situation: '守卫拦下商队', preparation: '当面核验领队身份',
        })
        if (status !== 'pending') await recordSceneResult(scene.sceneId, { status, simulation })
        return simulation
      },
    }, plan.id), status === 'completed' ? SyntaxError : /场景尚未结算/)
    const [scene] = await listStoryScenes(baseOptions, plan.id, eventId)
    assert.equal(scene?.status, status)
    assert.equal((await readStory(baseOptions, plan.id, eventId)).result, undefined)
    assert.equal(adapter.requests.length, status === 'completed' ? 4 : 3)
  }
})
