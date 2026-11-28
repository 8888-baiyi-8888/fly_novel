import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { createReviewSnapshot, reviewDigest, reviewPolicySchema, storyReviewSchema } from '../user-review.js'
import { continueStoryTree, createStoryPlan, inspectStoryProgress, readStory, readStoryReview, refreshStoryReview, runStoryTree, settleStoryReview, submitStoryReview, type StoryTreeOptions } from '../../app/story-workflow.js'
import { achieved, advance, leaf, ScriptedAdapter, setup, simulation, task } from './fixtures.js'
import type { CurrentConvoyEvidence } from '../world-progress.js'

test('审阅选项绑定原安排、期限、依赖和正文版本', () => {
  const first = randomUUID()
  const second = randomUUID()
  const input = {
    runId: randomUUID(), parentStoryId: randomUUID(), batch: 1, planHash: reviewDigest('原规划'),
    goal: '安排商队', constraints: [], evidenceHash: reviewDigest(null),
    children: [{ id: first, description: '核对城门' }, { id: second, description: '安置货物' }],
  }
  const policy = { kind: 'timed', durationMs: 10 } as const
  const reviewId = randomUUID()
  const review = createReviewSnapshot(input, reviewId, policy, 20)
  assert.equal(review.deadline, 30)
  assert.deepEqual(storyReviewSchema.parse(JSON.parse(JSON.stringify(review))), review)
  assert.throws(() => storyReviewSchema.parse({ ...review, formatVersion: 99 }))
  assert.throws(() => storyReviewSchema.parse({ ...review, goal: '更改正文' }), /正文不匹配/)
  assert.throws(() => createReviewSnapshot(input, reviewId, policy, 8_640_000_000_000_000))
  for (const durationMs of [0, -1, 0.5, Infinity]) assert.throws(() => reviewPolicySchema.parse({ kind: 'timed', durationMs }))
  const reversed = { id: 'reverse', label: '先安置货物', childIds: [second, first] }
  const proposals = { options: [reversed], recommendedId: 'reverse', recommendationReason: '先落实等候点' }
  assert.deepEqual(createReviewSnapshot(input, reviewId, { kind: 'indefinite' }, 20, proposals).options, [reversed])
  assert.throws(() => createReviewSnapshot(input, reviewId, policy, 20, { ...proposals, recommendedId: 'missing' }), /推荐项不存在/)
  assert.throws(() => createReviewSnapshot(input, reviewId, policy, 20, { ...proposals, options: [reversed, reversed] }), /选项重复/)
  assert.throws(() => createReviewSnapshot(input, reviewId, policy, 20, { ...proposals, options: [{ ...reversed, childIds: [first, first] }] }), /同一批子故事/)
  assert.throws(() => createReviewSnapshot(input, reviewId, policy, 20, { ...proposals, dependencies: [{ before: first, after: second }] }), /推进依赖/)
})

test('限时审阅拒绝过早结算，恰好到期只接受推荐项', async t => {
  const { baseOptions, plan } = await setup(t)
  let now = 200
  const clock = { ...baseOptions, now: () => now }
  const waiting = await runStoryTree({
    ...baseOptions, adapter: new ScriptedAdapter([]), simulate: async () => simulation,
    review: { policy: { kind: 'timed', durationMs: 10 }, now: clock.now },
  }, plan.id)
  assert.equal(waiting.kind, 'review')
  const { batch, review } = waiting
  const choice = { kind: 'select', optionId: review.recommendedId } as const
  await assert.rejects(settleStoryReview(clock, plan.id, batch, review), /尚未到期/)
  await assert.rejects(submitStoryReview(clock, plan.id, batch, { ...review, version: reviewDigest('过期') }, choice), /版本不匹配/)
  await assert.rejects(submitStoryReview(clock, plan.id, batch, review, { ...choice, optionId: 'missing' }), /选项不存在/)
  now = 210
  const [manual, timeout, duplicate] = await Promise.allSettled([
    submitStoryReview(clock, plan.id, batch, review, choice),
    settleStoryReview(clock, plan.id, batch, review),
    settleStoryReview(clock, plan.id, batch, review),
  ])
  assert.equal(manual.status, 'rejected')
  assert.match(String(manual.reason), /截止时间|已有其他审阅决定/)
  assert.equal(timeout.status, 'fulfilled')
  assert.deepEqual(duplicate, timeout)
  assert.deepEqual(timeout.value, { formatVersion: 1, reviewId: review.reviewId, version: review.version, source: 'timeout', decidedAt: 210, deadline: 210, choice })
  now = 211
  await assert.rejects(submitStoryReview(clock, plan.id, batch, review, { kind: 'cancel' }), /已有其他审阅决定/)
  assert.equal((await inspectStoryProgress(baseOptions, plan.id)).status, 'review-ready')
})

test('新进程读取到期审阅并结算，继续采用已保存的推荐顺序', async t => {
  const { baseOptions, plan } = await setup(t, ['核对闭门和等候条件', '安排货物'])
  const adapter = new ScriptedAdapter([...leaf('城门'), ...leaf('货物'), achieved])
  const simulated: string[] = []
  const options: StoryTreeOptions = {
    ...baseOptions, adapter,
    simulate: async ({ storyId }) => { simulated.push(storyId); return simulation },
    review: {
      policy: { kind: 'timed', durationMs: 10 }, now: () => 100,
      propose({ children }) {
        const childIds = children.map(item => item.id)
        return { recommendedId: 'rules', recommendationReason: '先确认闭门条件', options: [
          { id: 'rules', label: '先核对闭门条件', childIds },
          { id: 'goods', label: '先安排货物', childIds: [...childIds].reverse() },
        ] }
      },
    },
  }
  const pending = await runStoryTree(options, plan.id)
  assert.equal(pending.kind, 'review')
  const receipt = JSON.parse(execFileSync(process.execPath, ['-e', `
    const story = require(process.argv[1])
    const [rootsJson, runId, batch] = process.argv.slice(2)
    const options = JSON.parse(rootsJson)
    ;(async () => {
      const view = await story.readStoryReview(options, runId, Number(batch))
      if (view.decision !== undefined || view.consumed) throw new Error('预期待结算审阅')
      const receipt = await story.settleStoryReview({ ...options, now: () => 113 }, runId, Number(batch), view.review)
      process.stdout.write(JSON.stringify(receipt))
    })().catch(error => { console.error(error); process.exitCode = 1 })
  `, join(__dirname, '../../app/story-workflow.js'), JSON.stringify(baseOptions), plan.id, String(pending.batch)], { encoding: 'utf8' }))
  assert.equal(receipt.source, 'timeout')
  assert.equal(receipt.choice.optionId, 'rules')
  assert.equal(receipt.deadline, 110)
  assert.equal(receipt.decidedAt, 113)
  assert.deepEqual((await readStoryReview(baseOptions, plan.id, pending.batch)).decision, receipt)
  assert.equal((await continueStoryTree(options, plan.id, pending.batch)).kind, 'result')
  assert.deepEqual(simulated, pending.review.children.map(item => item.id))
})

test('持续等待可以明确取消，同一决定可重读且冲突决定被拒绝', async t => {
  const { baseOptions, plan } = await setup(t)
  const waiting = await runStoryTree({
    ...baseOptions, adapter: new ScriptedAdapter([]), simulate: async () => simulation,
    review: { policy: { kind: 'indefinite' }, now: () => 100 },
  }, plan.id)
  assert.equal(waiting.kind, 'review')
  const { batch, review } = waiting
  const clock = { ...baseOptions, now: () => 600 }
  await assert.rejects(settleStoryReview(clock, plan.id, batch, review), /没有超时决定/)
  const result = await submitStoryReview(clock, plan.id, batch, review, { kind: 'cancel' })
  assert.deepEqual(await submitStoryReview(clock, plan.id, batch, review, { kind: 'cancel' }), result)
  await assert.rejects(submitStoryReview(clock, plan.id, batch, review, { kind: 'select', optionId: 'original' }), /已有其他审阅决定/)
  assert.equal((await inspectStoryProgress(baseOptions, plan.id)).status, 'review-cancelled')
  assert.deepEqual((await readStoryReview(baseOptions, plan.id, batch)).decision, result)
  const adapter = new ScriptedAdapter([])
  await assert.rejects(continueStoryTree({
    ...baseOptions, adapter, simulate: async () => simulation,
    review: { policy: { kind: 'indefinite' } },
  }, plan.id, batch), /审阅已取消/)
  assert.equal(adapter.requests.length, 0)
})

test('嵌套审阅按采用顺序推进，独占消费并在普通暂停中核对采用依据', async t => {
  const { baseOptions, plan } = await setup(t, ['安置夜间抵达的商队'])
  const adapter = new ScriptedAdapter([
    advance, task, '{"kind":"split","children":["核对闭门规则","组织门外等候"]}',
    ...leaf('门外'), ...leaf('城门'), achieved, '已接收嵌套回报', achieved,
  ])
  const simulated: string[] = []
  const options: StoryTreeOptions = {
    ...baseOptions, adapter, limit: 1,
    simulate: async ({ storyId }) => { simulated.push(storyId); return simulation },
    review: {
      policy: { kind: 'indefinite' }, now: () => 100,
      propose({ children }) {
        if (children.length < 2) return undefined
        const childIds = children.map(child => child.id)
        return {
          options: [
            { id: 'rules', label: '先核对闭门规则', childIds },
            { id: 'waiting', label: '先组织门外等候', childIds: [...childIds].reverse() },
          ],
          recommendedId: 'rules', recommendationReason: '门规决定入城条件',
        }
      },
    },
  }
  const clock = { ...baseOptions, now: () => 150 }
  const root = await runStoryTree(options, plan.id)
  assert.equal(root.kind, 'review')
  await submitStoryReview(clock, plan.id, root.batch, root.review, { kind: 'select', optionId: 'original' })
  const nested = await continueStoryTree(options, plan.id, root.batch)
  assert.equal(nested.kind, 'review')
  assert.notEqual(nested.review.parentStoryId, root.storyId)
  assert.equal(nested.review.deadline, undefined)
  const parentId = nested.review.parentStoryId
  assert.deepEqual((await readStory(baseOptions, plan.id, parentId)).children.map(child => child.status), ['planned', 'planned'])
  assert.equal(simulated.length, 0)
  await submitStoryReview(clock, plan.id, nested.batch, nested.review, { kind: 'select', optionId: 'waiting' })
  const outcomes = await Promise.allSettled([
    continueStoryTree(options, plan.id, nested.batch),
    continueStoryTree(options, plan.id, nested.batch),
  ])
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1)
  const advanced = outcomes.find(item => item.status === 'fulfilled')!.value
  assert.equal(advanced.kind, 'paused')
  const inspected = await inspectStoryProgress(baseOptions, plan.id)
  assert.equal(inspected.status, 'paused')
  const [first, second] = nested.review.children
  assert.equal(inspected.next.storyId, first!.id)
  assert.deepEqual(simulated, [second!.id])
  const parent = await readStory(baseOptions, plan.id, parentId)
  assert.deepEqual(parent.children.map(child => child.id), [second!.id, first!.id])
  assert.equal(parent.adoptedReview?.optionId, 'waiting')
  assert.equal((await readStoryReview(baseOptions, plan.id, nested.batch)).consumed, true)
  const ended = await continueStoryTree(options, plan.id, advanced.batch)
  assert.equal(ended.kind, 'result')
  assert.deepEqual(simulated, [second!.id, first!.id])
  assert.equal((await inspectStoryProgress(baseOptions, plan.id)).status, 'completed')
})

test('审阅领取后调用中断，保留已采用证据并拒绝重复启动', async t => {
  const { baseOptions, plan } = await setup(t)
  const adapter = new ScriptedAdapter([])
  const options: StoryTreeOptions = {
    ...baseOptions, adapter, simulate: async () => simulation, review: { policy: { kind: 'indefinite' } },
  }
  const waiting = await runStoryTree(options, plan.id)
  assert.equal(waiting.kind, 'review')
  await submitStoryReview(baseOptions, plan.id, waiting.batch, waiting.review, { kind: 'select', optionId: 'original' })
  await assert.rejects(continueStoryTree(options, plan.id, waiting.batch))
  assert.equal((await inspectStoryProgress(baseOptions, plan.id)).status, 'needs-review')
  await assert.rejects(continueStoryTree(options, plan.id, waiting.batch), /审阅已取得推进位置/)
  assert.equal(adapter.requests.length, 1)
  assert.equal((await readStoryReview(baseOptions, plan.id, waiting.batch)).consumed, true)
})

test('依据更新后原决定不能推进，应用保存新版并要求再次确认', async t => {
  const { baseOptions } = await setup(t)
  const worldId = '曲水城'
  const content = '夜间闭门'
  const digest = reviewDigest('状态')
  const { planRoot, collaborationRoot } = baseOptions
  const plan = await createStoryPlan({
    ...baseOptions, root: planRoot, protectedRoots: [collaborationRoot],
    adapter: new ScriptedAdapter(['{"kind":"planned","events":["核对闭门规则"]}']),
  }, {
    task: '安置商队', facts: [content], directions: [],
    world: { worldId, deliveryId: randomUUID(), deliveryVersion: '1', reviewVersion: '1',
      materials: [{ category: 'setting', source: { kind: 'fixed', id: '城门' }, version: '1', content, digest: createHash('sha256').update(content).digest('hex') }],
      notes: [], uncovered: [], deferred: [] },
  })
  const convoyId = randomUUID()
  let current: CurrentConvoyEvidence = { worldId, convoyId, status: 'arrived', revision: 0, digest }
  const worldProgress = {
    worldId, runId: plan.id, current: async () => current,
    event: async () => { throw new Error('没有已采用事件') },
  }
  let now = 100
  const adapter = new ScriptedAdapter([])
  const options: StoryTreeOptions = {
    ...baseOptions, worldProgress, adapter, simulate: async () => simulation,
    review: { policy: { kind: 'timed', durationMs: 30 }, now: () => now },
  }
  const input = { ...baseOptions, worldProgress, now: () => now }
  const pending = await runStoryTree(options, plan.id)
  assert.equal(pending.kind, 'review')
  const select = { kind: 'select', optionId: 'original' } as const
  const original = await submitStoryReview(input, plan.id, pending.batch, pending.review, select)
  current = { worldId, convoyId, status: 'waiting', revision: 1, digest: reviewDigest('新状态'),
    eventId: digest, operationId: randomUUID(), locationId: '门外等候点' }
  await assert.rejects(continueStoryTree(options, plan.id, pending.batch), /依据已变化/)
  await assert.rejects(refreshStoryReview(baseOptions, plan.id, pending.batch, pending.review), /原世界状态来源/)
  now = 120
  const replacement = await refreshStoryReview(input, plan.id, pending.batch, pending.review)
  assert.equal(replacement.deadline, 150)
  assert.equal(replacement.worldState?.revision, 1)
  assert.notEqual(replacement.version, pending.review.version)
  assert.deepEqual(await refreshStoryReview(input, plan.id, pending.batch, pending.review), replacement)
  await assert.rejects(submitStoryReview(input, plan.id, pending.batch, pending.review, select), /版本已被替代/)
  assert.deepEqual(await readStoryReview(baseOptions, plan.id, pending.batch), {
    review: pending.review, decision: original, consumed: false, replacementBatch: replacement.batch,
  })
  assert.equal((await inspectStoryProgress(baseOptions, plan.id)).status, 'awaiting-review')
  await assert.rejects(continueStoryTree(options, plan.id, replacement.batch), /需要审阅决定/)
  assert.equal(adapter.requests.length, 0)
})

test('根故事在初步拆分后等待，重开时只读原版本和期限', async t => {
  const { baseOptions, plan } = await setup(t)
  let now = 100
  const adapter = new ScriptedAdapter([])
  const options: StoryTreeOptions = {
    ...baseOptions, adapter, simulate: async () => simulation,
    review: { policy: { kind: 'timed', durationMs: 25 }, now: () => now },
  }
  const waiting = await runStoryTree(options, plan.id)
  assert.equal(waiting.kind, 'review')
  assert.equal(waiting.review.deadline, 125)
  assert.equal((await inspectStoryProgress(baseOptions, plan.id)).status, 'awaiting-review')
  now = 130
  assert.deepEqual(await readStoryReview(baseOptions, plan.id, waiting.batch), { review: waiting.review, consumed: false, decision: undefined })
  await assert.rejects(continueStoryTree(options, plan.id, waiting.batch), /需要审阅决定/)
  assert.deepEqual((await readStory(baseOptions, plan.id)).children.map(child => child.status), ['planned', 'planned'])
  assert.equal(adapter.requests.length, 0)
})
