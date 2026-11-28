import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createReviewSnapshot, reviewDigest, reviewPolicySchema, storyReviewSchema } from '../user-review.js'
import { continueStoryTree, inspectStoryProgress, readStory, readStoryReview, runStoryTree, type StoryTreeOptions } from '../../app/story-workflow.js'
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
  assert.deepEqual(await readStoryReview(baseOptions, plan.id, waiting.batch), waiting.review)
  await assert.rejects(continueStoryTree(options, plan.id, waiting.batch), /需要审阅决定/)
  assert.deepEqual((await readStory(baseOptions, plan.id)).children.map(child => child.status), ['planned', 'planned'])
  assert.equal(adapter.requests.length, 0)
})
