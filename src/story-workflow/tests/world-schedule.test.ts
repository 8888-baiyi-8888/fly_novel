import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { openWorldScheduleStore, sceneScheduleReadiness, scheduleDigest, worldScheduleSchema, type ScheduleSlot, type WorldSchedule } from '../world-schedule.js'
import { createStoryPlan, createStoryScene, openStoryWorldSchedule, runStoryTree } from '../../app/story-workflow.js'
import { achieved, createTestDirectory, leaf, ScriptedAdapter, simulation } from './fixtures.js'

const worldId = '曲水城'
const guard = randomUUID()
const north = '北门'
const office = '值所'
const slot = (start: number, end: number, locationId = north): ScheduleSlot => ({
  id: randomUUID(), runId: randomUUID(), start, end, locationId, characters: [guard], dependencies: [], targets: [],
})
const schedule = (slots: ScheduleSlot[]): WorldSchedule => ({
  formatVersion: 1, worldId, epoch: '抵达当夜', revision: 0, previous: null, reason: '登记时间窗',
  window: { id: randomUUID(), start: 0, end: 60, sealed: false, slots, routes: [], positions: [{ characterId: guard, locationId: north }] },
})

test('角色交接按已结算地点、通行方向和剩余世界时间判定', () => {
  const first = slot(0, 10)
  assert.throws(() => worldScheduleSchema.parse(schedule([first, slot(8, 12)])), /同一角色.*重叠/)
  const later = slot(20, 25, office)
  const { window } = schedule([first, later])
  window.sealed = true
  assert.deepEqual(sceneScheduleReadiness(window, later).blocks, [{ kind: 'predecessor', slotId: first.id, characterId: guard }])
  window.slots[0] = { ...first, claim: { storyId: randomUUID(), sceneId: 'scene', setupDigest: scheduleDigest(null), token: randomUUID(), routes: [] },
    resolution: { kind: 'settled', evidenceDigest: scheduleDigest('结束位置'), positions: [{ characterId: guard, locationId: north }] } }
  const route = { from: north, to: office, duration: 10, sourceId: '地图连接', version: '1', passage: 'allowed' as const, basis: '可沿城墙步行' }
  window.routes = [{ ...route, from: office, to: north }]
  assert.equal(sceneScheduleReadiness(window, later).blocks[0]?.kind, 'no-route')
  window.routes = [{ ...route, passage: 'unknown' }]
  assert.equal(sceneScheduleReadiness(window, later).blocks[0]?.kind, 'passage')
  window.routes = [route]
  assert.equal(sceneScheduleReadiness(window, { ...later, start: 19 }).blocks[0]?.kind, 'travel-time')
  assert.deepEqual(sceneScheduleReadiness(window, later), { blocks: [], routes: [route] })
  assert.deepEqual(sceneScheduleReadiness(window, { ...later, locationId: north, start: 10 }).blocks, [])
})

async function fixture(t: Parameters<typeof createTestDirectory>[0]) {
  const root = await createTestDirectory(t, 'scheduled-stories-')
  const planRoot = join(root, 'plans')
  const collaborationRoot = join(root, 'scenes')
  const scheduleRoot = join(root, 'schedule')
  await Promise.all([mkdir(planRoot), mkdir(collaborationRoot), mkdir(scheduleRoot)])
  const roots = { planRoot, collaborationRoot, protectedRoots: [] }
  const model = { provider: 'fixed', model: 'fixed' }
  const content = '夜间闭门'
  const { createHash } = await import('node:crypto')
  const createPlan = (events: string[]) => createStoryPlan({
    ...model, root: planRoot, protectedRoots: [collaborationRoot, scheduleRoot],
    adapter: new ScriptedAdapter([JSON.stringify({ kind: 'planned', events })]),
  }, {
    task: '曲水城商贸', facts: [content], directions: [],
    world: { worldId, deliveryId: randomUUID(), deliveryVersion: '1', reviewVersion: '1',
      materials: [{ category: 'setting', source: { kind: 'fixed', id: '北门规则' }, version: '1', content,
        digest: createHash('sha256').update(content).digest('hex') }], notes: [], uncovered: [], deferred: [] },
  })
  return { roots, model, createPlan, options: { worldId, scheduleRoot, maxConcurrent: 2 } }
}

test('正式故事入口并发推进独立场景，重复领取被拒绝，已结算排期可重读', { timeout: 10000 }, async t => {
  const { roots, model, createPlan, options } = await fixture(t)
  const [gatePlan, officePlan] = await Promise.all([createPlan(['北门交涉']), createPlan(['值所准备'])])
  const dispatcher = await openStoryWorldSchedule(roots, options)
  t.after(() => dispatcher.close())
  await assert.rejects(openStoryWorldSchedule(roots, options), /已有调度器/)
  const clerk = randomUUID()
  const gate = { ...slot(0, 10), runId: gatePlan.id }
  const other = { ...slot(2, 8, office), runId: officePlan.id, characters: [clerk] }
  const draft = await dispatcher.openWindow({ id: randomUUID(), epoch: '当夜', start: 0, end: 60,
    positions: [{ characterId: guard, locationId: north }, { characterId: clerk, locationId: office }], routes: [] })
  await dispatcher.revise(draft.revision, { slots: [gate, other], seal: true, reason: '批准同时演绎' })
  let releaseBoth!: () => void
  const both = new Promise<void>(resolve => { releaseBoth = resolve })
  const began: string[] = []
  const run = (planned: ScheduleSlot) => runStoryTree({
    ...roots, ...model, adapter: new ScriptedAdapter([...leaf('曲水城'), achieved]),
    async simulate(input, signal) {
      const saved = await createStoryScene(roots, input.runId, input.storyId, { order: 1, situation: planned.locationId, preparation: '执行排期' })
      const identity = { storyId: input.storyId, sceneId: saved.sceneId }
      return dispatcher.execute(planned.id, identity, async permit => {
        const allowed = planned.characters[0]!
        permit.assertCharacter(allowed, saved.sceneId, input.runId, input.storyId)
        assert.throws(() => permit.assertCharacter(randomUUID(), saved.sceneId, input.runId, input.storyId), /超出当前排期/)
        await assert.rejects(async () => dispatcher.execute(planned.id, identity, async () => simulation, signal), /已经领取/)
        began.push(planned.id)
        if (began.length === 2) releaseBoth()
        await both
        await input.recordSceneResult(saved.sceneId, { status: 'completed', simulation })
        return simulation
      }, signal)
    },
  }, planned.runId)
  try {
    const outcomes = await Promise.all([run(gate), run(other)])
    assert.deepEqual(outcomes.map(item => item.kind), ['result', 'result'])
    assert.equal(began.length, 2)
    assert.deepEqual((await dispatcher.view()).slots.map(item => item.status), ['settled', 'settled'])
    await dispatcher.close()
    const reopened = await openStoryWorldSchedule(roots, options)
    try {
      assert.deepEqual((await reopened.view()).slots.map(item => item.status), ['settled', 'settled'])
      await reopened.reconcile(gate.id)
    } finally { await reopened.close() }
  } finally { releaseBoth() }
})

test('世界时间窗拒绝反向区间、越界、未来依赖以及未知版本', () => {
  const first = slot(0, 10)
  const second = { ...slot(20, 25, office), dependencies: [{ slotId: first.id, kind: 'result' as const }] }
  assert.doesNotThrow(() => worldScheduleSchema.parse(schedule([first, second])))
  assert.throws(() => worldScheduleSchema.parse(schedule([slot(10, 10)])), /方向无效/)
  assert.throws(() => worldScheduleSchema.parse(schedule([slot(59, 61)])), /超出时间窗/)
  assert.throws(() => worldScheduleSchema.parse(schedule([{ ...first, dependencies: [{ slotId: second.id, kind: 'order' }] }, second])), /循环/)
  assert.throws(() => worldScheduleSchema.parse({ ...schedule([first]), formatVersion: 99 }))
})

test('排期修订历史可重开，身份或预期版本有误时拒绝发布', async t => {
  const root = await createTestDirectory(t, 'world-schedule-')
  const store = await openWorldScheduleStore(root, [], worldId)
  const first = await store.save(schedule([slot(0, 10)]))
  const approved = await store.save({ ...first, revision: 1, previous: scheduleDigest(first), window: { ...first.window, sealed: true } })
  assert.deepEqual(await (await openWorldScheduleStore(root, [], worldId)).latest(), approved)
  assert.deepEqual(await store.read(0), first)
  await assert.rejects(store.save({ ...first, revision: 1, previous: scheduleDigest(first) }), /预期版本/)
  await assert.rejects(store.save({ ...approved, worldId: '其他世界', revision: 2, previous: scheduleDigest(approved) }), /预期版本/)
})
