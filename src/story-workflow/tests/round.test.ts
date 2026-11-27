import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { continueStoryTree, createNextStoryPlan, readStoryRoundResult, runStoryTree, type StoryTreeOptions } from '../../app/story-workflow.js'
import { ScriptedAdapter, achieved, advance, leaf, setup, simulation, task } from './fixtures.js'

test('曲水城整轮演化跨批次推进，结束后使用更新资料开始下一轮', async t => {
  const { baseOptions, plan } = await setup(t)
  const notification = { id: randomUUID(), situation: '城门外道路积水' }
  const played: string[] = []
  const simulate: StoryTreeOptions['simulate'] = async ({ preparation, reportEarly }) => {
    played.push(preparation)
    if (preparation === '查验身份') {
      const decision = await reportEarly(notification)
      assert.deepEqual(decision, { action: 'adjust', reason: '积水影响城门', direction: '转移至高地' })
      played.push(decision.direction)
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
  const nextInput = { task: '规划商队天亮后的行动', facts: ['用户提供的新一轮局势：商队已得到临时仓位'], directions: ['重启商贸'] }
  const planning = { root: baseOptions.planRoot, collaborationRoot: baseOptions.collaborationRoot, protectedRoots: [], provider: 'test', model: 'test', adapter: new ScriptedAdapter(['{"kind":"planned","events":["办理天亮后的入城手续"]}']) }
  await assert.rejects(createNextStoryPlan(planning, plan.id, nextInput), { code: 'ENOENT' })
  assert.equal(planning.adapter.requests.length, 0)

  const pausePath = join(baseOptions.collaborationRoot, `${plan.id}.${paused.batch}.paused.story.json`)
  const savedProgress = await readFile(pausePath, 'utf8')
  const batchOptions = { ...baseOptions, limit: 2, simulate, adapter: new ScriptedAdapter([
    ...leaf('交涉入城'), '{"status":"supplement","reason":"仍需转移货物","description":"协商临时仓位"}',
    ...leaf('协商临时仓位'), achieved, '根导演收到城门故事回报',
  ]) }
  for (const invalid of [savedProgress.replace('"formatVersion": 1', '"formatVersion": 99'), '{']) {
    await writeFile(pausePath, invalid)
    await assert.rejects(continueStoryTree(batchOptions, plan.id, paused.batch))
    assert.equal(await readFile(pausePath, 'utf8'), invalid)
  }
  assert.equal(batchOptions.adapter.requests.length, 0)
  await writeFile(pausePath, savedProgress)
  const attempts = await Promise.allSettled([
    continueStoryTree(batchOptions, plan.id, paused.batch),
    continueStoryTree(batchOptions, plan.id, paused.batch),
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
  const next = await createNextStoryPlan(planning, plan.id, nextInput)
  assert.notEqual(next.id, plan.id)
  assert.deepEqual(next.input, nextInput)
  assert.match(JSON.stringify(planning.adapter.requests[0]?.messages), /商队已得到临时仓位/)
  const nextEnd = await runStoryTree({ ...baseOptions, simulate, adapter: new ScriptedAdapter([...leaf('办理入城手续'), achieved]) }, next.id)
  assert.equal(nextEnd.kind, 'result')
  assert.equal((await readStoryRoundResult(baseOptions, plan.id)).result.storyId, ended.storyId)
})
