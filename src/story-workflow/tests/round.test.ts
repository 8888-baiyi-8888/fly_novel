import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { continueStoryTree, createNextStoryPlan, createStoryScene, inspectStoryProgress, listStoryScenes, readStory, readStoryPlan, readStoryRoundResult, readStoryScene, runStoryTree, type StoryTreeOptions } from '../../app/story-workflow.js'
import { ScriptedAdapter, achieved, advance, leaf, setup, simulation, task } from './fixtures.js'

test('曲水城从初步规划追溯两个场景，跨批继续后重读整轮及下一轮结果', async t => {
  const { baseOptions, plan, eventId } = await setup(t)
  const { planRoot, collaborationRoot, protectedRoots } = baseOptions
  const records = { planRoot, collaborationRoot, protectedRoots }
  const gate = { order: 1, situation: '商队夜间抵达已关闭的城门', preparation: '守卫与领队交涉入城请求' }
  const outside = { order: 2, situation: '商队等待入城期间需要临时安置', preparation: '核对高地是否可以临时停放货车' }
  const gateResult = { ...simulation, summary: '守卫拒绝开门，领队将车队移出入口' }
  const outsideResult = { ...simulation, summary: '商队在高地等候，货物登记留待天亮后处理' }
  const notification = { id: randomUUID(), situation: '城门外道路积水' }
  const played: string[] = []
  const simulate: StoryTreeOptions['simulate'] = async ({ runId, storyId, preparation, reportEarly, recordSceneResult }) => {
    played.push(preparation)
    if (preparation === '查验身份') {
      assert.equal(runId, plan.id)
      const firstScene = await createStoryScene(records, runId, storyId, gate)
      assert.equal(firstScene.status, 'pending')
      await recordSceneResult(firstScene.sceneId, { status: 'completed', simulation: gateResult })
      const decision = await reportEarly(notification)
      assert.deepEqual(decision, { action: 'adjust', reason: '积水影响城门', direction: '转移至高地' })
      played.push(decision.direction)
      const secondScene = await createStoryScene(records, runId, storyId, outside)
      await recordSceneResult(secondScene.sceneId, { status: 'completed', simulation: outsideResult })
    }
    return simulation
  }
  const first = leaf('查验身份')
  const noticeReport = JSON.stringify({ summary: '道路积水', changes: ['城外道路受阻'], unresolved: ['商队等候点'], evidence: '模拟观察' })
  first.splice(3, 0, noticeReport, '{"action":"adjust","reason":"积水影响城门","direction":"转移至高地"}')
  const paused = await runStoryTree({ ...baseOptions, limit: 1, simulate, adapter: new ScriptedAdapter([
    advance, task, '{"kind":"split","children":["查验身份","交涉入城"]}', ...first,
  ]) }, plan.id)
  if (paused.kind !== 'paused') throw new Error('预期在第一批后暂停')
  assert.equal(paused.completedCount, 1)
  assert.deepEqual(await readStoryPlan({ root: planRoot, protectedRoots: [collaborationRoot] }, plan.id), plan)
  const root = await readStory(records, plan.id)
  assert.equal(root.node.storyId, paused.storyId)
  assert.equal(root.parent, null)
  assert.deepEqual(root.children.map(child => child.description), ['商队夜间抵达', '处理货物'])
  const parent = await readStory(records, plan.id, eventId)
  assert.equal(parent.parent?.storyId, root.node.storyId)
  const story = await readStory(records, plan.id, parent.children[0]!.id)
  const storyId = story.node.storyId
  assert.equal(story.parent?.storyId, eventId)
  assert.equal(story.node.description, '查验身份')
  assert.equal(story.result?.value.summary, '守卫拒绝开门')
  if (story.result?.formatVersion !== 2) throw new Error('预期可追溯到场景的回报')
  const scenes = await Promise.all(story.result.sceneIds.map(id => readStoryScene(records, plan.id, storyId, id)))
  assert.deepEqual(await listStoryScenes(records, plan.id, storyId), scenes)
  assert.deepEqual(scenes.map(({ order, situation, preparation }) => ({ order, situation, preparation })), [gate, outside])
  assert.deepEqual(scenes.map(scene => 'result' in scene && scene.result.simulation), [gateResult, outsideResult])
  const inspected = await inspectStoryProgress(records, plan.id)
  if (inspected.status !== 'paused') throw new Error('预期重读可继续暂停')
  assert.equal(inspected.batch, paused.batch)
  assert.equal(inspected.current.storyId, eventId)
  assert.equal(inspected.next.storyId, parent.children[1]!.id)
  assert.equal(inspected.completedCount, 1)

  const nextInput = { task: '规划商队天亮后的行动', facts: ['用户提供的新一轮局势：商队已得到临时仓位'], directions: ['重启商贸'] }
  const planning = { root: baseOptions.planRoot, collaborationRoot: baseOptions.collaborationRoot, protectedRoots: [], provider: 'test', model: 'test', adapter: new ScriptedAdapter(['{"kind":"planned","events":["办理天亮后的入城手续"]}']) }
  await assert.rejects(createNextStoryPlan(planning, plan.id, nextInput), { code: 'ENOENT' })
  assert.equal(planning.adapter.requests.length, 0)

  const pausePath = join(baseOptions.collaborationRoot, `${plan.id}.${paused.batch}.paused.story.json`)
  const savedProgress = await readFile(pausePath, 'utf8')
  assert.match(savedProgress, /^\{\s*"formatVersion": 2,/)
  const batchOptions = { ...baseOptions, limit: 2, simulate, adapter: new ScriptedAdapter([
    ...leaf('交涉入城'), '{"status":"supplement","reason":"仍需转移货物","description":"协商临时仓位"}',
    ...leaf('协商临时仓位'), achieved, '根导演收到城门故事回报',
  ]) }
  for (const invalid of [savedProgress.replace(/^\{\s*"formatVersion": 2,/, '{"formatVersion": 99,'), '{']) {
    await writeFile(pausePath, invalid)
    await assert.rejects(continueStoryTree(batchOptions, plan.id, paused.batch))
    assert.equal(await readFile(pausePath, 'utf8'), invalid)
  }
  assert.equal(batchOptions.adapter.requests.length, 0)
  await writeFile(pausePath, savedProgress)
  const attempts = await Promise.allSettled([
    continueStoryTree(batchOptions, plan.id, inspected.batch),
    continueStoryTree(batchOptions, plan.id, inspected.batch),
  ])
  const accepted = attempts.find(attempt => attempt.status === 'fulfilled')
  const rejected = attempts.find(attempt => attempt.status === 'rejected')
  assert.match(String(rejected?.reason), /已使用/)
  if (!accepted || accepted.value.kind !== 'paused') throw new Error('预期在第二批后暂停')
  assert.equal(accepted.value.completedCount, 2)
  assert.match(JSON.stringify(batchOptions.adapter.requests[0]?.messages), /守卫拒绝开门/)

  const ended = await continueStoryTree({ ...baseOptions, simulate, adapter: new ScriptedAdapter([...leaf('处理货物'), achieved]) }, plan.id, accepted.value.batch)
  assert.equal(ended.kind, 'result')
  assert.equal(ended.completedCount, 1)
  assert.deepEqual(played, ['查验身份', '转移至高地', '交涉入城', '协商临时仓位', '处理货物'])
  const saved = await readStoryRoundResult(baseOptions, plan.id)
  assert.equal(saved.result.storyId, ended.storyId)
  assert.equal(saved.assessment.status, 'achieved')
  const completed = await inspectStoryProgress(records, plan.id)
  if (completed.status !== 'completed') throw new Error('预期从业务证据核对整轮完成')
  assert.equal(completed.completedCount, 4)
  assert.deepEqual(completed.confirmed.find(({ result }) => result.storyId === storyId)?.result, story.result)
  assert.deepEqual(await listStoryScenes(records, plan.id, storyId), scenes)
  const next = await createNextStoryPlan(planning, plan.id, nextInput)
  assert.notEqual(next.id, plan.id)
  assert.deepEqual(next.input, nextInput)
  assert.match(JSON.stringify(planning.adapter.requests[0]?.messages), /商队已得到临时仓位/)
  const nextEnd = await runStoryTree({ ...baseOptions, simulate, adapter: new ScriptedAdapter([...leaf('办理入城手续'), achieved]) }, next.id)
  assert.equal(nextEnd.kind, 'result')
  const nextRoot = await readStory(records, next.id)
  const nextStory = await readStory(records, next.id, nextRoot.children[0]!.id)
  assert.equal(nextStory.result?.formatVersion, 1)
  assert.deepEqual(await listStoryScenes(records, next.id, nextStory.node.storyId), [])
  assert.equal((await readStoryRoundResult(baseOptions, plan.id)).result.storyId, ended.storyId)
})
