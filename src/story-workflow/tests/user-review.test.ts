import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createReviewSnapshot, reviewDigest, reviewPolicySchema, storyReviewSchema } from '../user-review.js'
import { continueStoryTree, inspectStoryProgress, readStory, readStoryReview, runStoryTree, settleStoryReview, submitStoryReview, type StoryTreeOptions } from '../../app/story-workflow.js'
import { ScriptedAdapter, setup, simulation } from './fixtures.js'

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

test('限时审阅在截止前接受手选，恰好到期只接受推荐项', async t => {
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
