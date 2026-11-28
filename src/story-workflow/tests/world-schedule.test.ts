import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { openWorldScheduleStore, scheduleDigest, worldScheduleSchema, type ScheduleSlot, type WorldSchedule } from '../world-schedule.js'
import { createTestDirectory } from './fixtures.js'

const worldId = '曲水城'
const guard = randomUUID()
const north = '北门'
const office = '值所'
const slot = (start: number, end: number, locationId = north): ScheduleSlot => ({
  id: randomUUID(), runId: randomUUID(), start, end, locationId, characters: [guard], dependencies: [], targets: [],
})
const schedule = (slots: ScheduleSlot[]): WorldSchedule => ({
  formatVersion: 1, worldId, epoch: '抵达当夜', revision: 0, previous: null, reason: '登记时间窗',
  window: { id: randomUUID(), start: 0, end: 60, sealed: false, slots, positions: [{ characterId: guard, locationId: north }] },
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
