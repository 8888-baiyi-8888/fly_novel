import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { openWorldScheduleStore, sceneScheduleReadiness, scheduleDigest, worldScheduleSchema, type ScheduleSlot, type WorldSchedule } from '../world-schedule.js'
import { bindStoryCharacters, createStoryPlan, createStoryScene, openStoryCharacterRuntime, openStoryConvoyState, openStoryEvents, openStorySceneInteraction, openStoryWorldSchedule, runStoryTree, type bindStoryWorld } from '../../app/story-workflow.js'
import { CharacterStore } from '@fly-novel/character'
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

test('排期允许同一状态读读重叠，按时间阻止读写和写写冲突', () => {
  const convoy = randomUUID()
  const earlier = { ...slot(0, 10), characters: [], targets: [{ id: convoy, mode: 'write' as const }] }
  const reader = { ...slot(9, 20), characters: [], targets: [{ id: convoy, mode: 'read' as const }] }
  assert.throws(() => worldScheduleSchema.parse(schedule([earlier, reader])), /共享状态.*重叠/)
  assert.throws(() => worldScheduleSchema.parse(schedule([earlier, { ...reader, targets: earlier.targets }])), /共享状态.*重叠/)
  assert.doesNotThrow(() => worldScheduleSchema.parse(schedule([{ ...earlier, targets: reader.targets }, reader])))
  const later = { ...reader, start: 10 }
  const { window } = schedule([earlier, later])
  window.sealed = true
  assert.deepEqual(sceneScheduleReadiness(window, later).blocks, [{ kind: 'predecessor', slotId: earlier.id, targetId: convoy }])
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
  const deliveryId = randomUUID()
  const createPlan = (events: string[]) => createStoryPlan({
    ...model, root: planRoot, protectedRoots: [collaborationRoot, scheduleRoot],
    adapter: new ScriptedAdapter([JSON.stringify({ kind: 'planned', events })]),
  }, {
    task: '曲水城商贸', facts: [content], directions: [],
    world: { worldId, deliveryId, deliveryVersion: '1', reviewVersion: '1',
      materials: [{ category: 'setting', source: { kind: 'fixed', id: '北门规则' }, version: '1', content,
        digest: createHash('sha256').update(content).digest('hex') }], notes: [], uncovered: [], deferred: [] },
  })
  return { root, roots, model, createPlan, deliveryId, options: { worldId, scheduleRoot, maxConcurrent: 2 } }
}

test('跨故事经历按真实感知逐角色装配，泄露和未登记角色调用被拒绝', { timeout: 10000 }, async t => {
  const { root, roots, model, createPlan, deliveryId, options } = await fixture(t)
  const worldRoot = join(root, 'world')
  const characterRoot = join(worldRoot, 'characters')
  await mkdir(characterRoot, { recursive: true })
  const characters = await CharacterStore.open(characterRoot, true)
  const owner = { agentId: 'characters', writableRoot: characters.rootDirectory }
  const binding: Awaited<ReturnType<typeof bindStoryWorld>> = {
    deliveryId, world: { worldId, readRoot: worldRoot, confirmedRoot: worldRoot, catalogRoot: worldRoot, mainAgent: owner, agents: [owner] },
    async readDelivery() { throw new Error('使用固定交付'); },
  }
  const actors = await Promise.all(['守卫', '领队', '书记员'].map(async name => {
    const { id: characterId } = await characters.create({ name, summary: name, categories: {}, body: name })
    return { characterId, version: (await characters.readVersioned(characterId)).version, presence: '在场', name }
  }))
  const [gateGuard, leader, clerk] = actors as [typeof actors[number], typeof actors[number], typeof actors[number]]
  const [gatePlan, officePlan] = await Promise.all([createPlan(['北门交涉']), createPlan(['值所交接'])])
  const stateRoot = join(root, 'state')
  await mkdir(stateRoot)
  const convoy = { convoyId: randomUUID(), stateRoot, worldRoot, async authorize() { return '获准在北门等候' } }
  const gateState = await openStoryConvoyState(roots, { ...convoy, worldId, runId: gatePlan.id })
  await gateState.initialize({ sourceId: '商队已抵达', version: '1' })
  const dispatcher = await openStoryWorldSchedule(roots, { ...options, convoy, async allowExperience() { return true } })
  try {
    const before = { ...slot(0, 10), runId: gatePlan.id, characters: actors.map(actor => actor.characterId),
      targets: [{ id: convoy.convoyId, mode: 'write' as const }] }
    const later = { ...slot(20, 25, office), runId: officePlan.id, characters: [gateGuard.characterId, clerk.characterId],
      targets: [{ id: convoy.convoyId, mode: 'read' as const }] }
    const initial = await dispatcher.openWindow({ id: randomUUID(), epoch: '当夜', start: 0, end: 60,
      positions: actors.map(actor => ({ characterId: actor.characterId, locationId: north })),
      routes: [{ from: north, to: office, duration: 10, sourceId: '城墙路', version: '1', passage: 'allowed', basis: '已核查通行' }] })
    await dispatcher.revise(initial.revision, { slots: [before, later], seal: true, reason: '批准交接排期' })
    const early = new ScriptedAdapter([JSON.stringify({ kind: 'respond', speech: [
      { text: '货物快坏了', channel: 'whisper', intendedCharacterIds: [gateGuard.characterId] },
      { text: '登记暗号', channel: 'whisper', intendedCharacterIds: [clerk.characterId] },
    ], actions: ['停稳车辆'], privateThought: '领队私念' })])
    const guardModel = new ScriptedAdapter(['{"kind":"wait"}'])
    const clerkModel = new ScriptedAdapter(['{"kind":"wait"}'])
    const run = (planned: ScheduleSlot) => runStoryTree({
      ...roots, ...model, adapter: new ScriptedAdapter([...leaf('交接'), achieved]), worldProgress: dispatcher.progress(planned.runId),
      async simulate(input, signal) {
        const saved = await createStoryScene(roots, input.runId, input.storyId, { order: 1, situation: '依照排期准备', preparation: '登记' })
        return dispatcher.execute(planned.id, { storyId: input.storyId, sceneId: saved.sceneId }, async (permit, activeSignal) => {
          const scope = bindStoryCharacters(roots, input, { binding, ownerAgentId: owner.agentId, store: characters, candidates: actors })
          const runtime = await openStoryCharacterRuntime(scope, characterId => ({
            ...model, version: '1', timeoutMs: 5000, adapter: planned === before ? early : characterId === gateGuard.characterId ? guardModel : clerkModel,
          }))
          try {
            const respond = async (actor: typeof leader) => {
              const [request] = await scope.select(saved.sceneId, [actor.characterId], async () => JSON.stringify({ participants: [{ characterId: actor.characterId, invitation: '交谈' }] }))
              return runtime.respond(request!, [
                { characterId: actor.characterId, sceneId: saved.sceneId, category: 'profile', content: actor.name, basis: '固定档案', source: { kind: 'profile' } },
                { characterId: actor.characterId, sceneId: saved.sceneId, category: 'observation', content: saved.situation, basis: '当前处境', source: { kind: 'scene', field: 'situation' } },
              ], activeSignal)
            }
            if (planned === before) {
              const response = await respond(leader)
              assert.equal(response.outcome.status, 'responded')
              const interaction = openStorySceneInteraction(roots, { runId: input.runId, storyId: input.storyId, sceneId: saved.sceneId })
              await interaction.append(1, response.participationId, { version: '1', participants: actors.map(actor => ({
                characterId: actor.characterId, hearing: 'clear', sight: 'clear', position: north, basis: '临近',
              })) })
              await interaction.judgeActions(1, async () => JSON.stringify([{ index: 0, status: 'succeeded', reason: '车辆停稳', observable: '商队已在北门等候' }]))
              await interaction.decide(1, '1', async () => JSON.stringify({ next: { kind: 'end', reason: '交谈结束' }, perceptions: [
                { characterId: leader.characterId, status: 'not-received', reason: '本人发言', observations: [] },
                { characterId: gateGuard.characterId, status: 'received', reason: '耳语对象', observations: [{ kind: 'speech', index: 0 }] },
                { characterId: clerk.characterId, status: 'received', reason: '耳语对象', observations: [{ kind: 'speech', index: 1 }] },
              ] }))
            } else {
              assert.equal(permit.state?.status, 'waiting')
              assert.equal((await dispatcher.progress(input.runId).current()).status, 'waiting')
              await assert.rejects(respond(leader), /超出当前排期/)
              const first = await permit.experiences(gateGuard.characterId)
              assert.deepEqual(await permit.experiences(gateGuard.characterId), first)
              assert.equal(first.length, 1)
              await respond(gateGuard)
              await respond(clerk)
            }
            await input.recordSceneResult(saved.sceneId, { status: 'completed', simulation })
            if (planned === before) {
              const evidence = { runId: input.runId, storyId: input.storyId, sceneId: saved.sceneId }
              const event = await openStoryEvents(roots, { worldId, runId: input.runId }).adopt(evidence)
              const operationId = randomUUID()
              await gateState.prepare({ worldId, convoyId: convoy.convoyId, expectedRevision: 0, locationId: north, operationId,
                evidence: { ...evidence, eventId: event.eventId, sequence: 1, actionIndex: 0 } })
              assert.equal((await gateState.apply(operationId, activeSignal)).status, 'applied')
              assert.equal((await gateState.progress.current()).status, 'arrived')
              assert.equal((await gateState.apply(operationId, activeSignal)).status, 'applied')
            }
            return simulation
          } finally { await runtime.close() }
        }, signal)
      },
    }, planned.runId)
    assert.deepEqual((await Promise.all([run(later), run(before)])).map(result => result.kind), ['result', 'result'])
    assert.match(JSON.stringify(guardModel.requests), /货物快坏了/)
    assert.doesNotMatch(JSON.stringify(guardModel.requests), /登记暗号|领队私念/)
    assert.match(JSON.stringify(clerkModel.requests), /登记暗号/)
    assert.doesNotMatch(JSON.stringify(clerkModel.requests), /货物快坏了|领队私念/)
    const settled = (await dispatcher.view()).slots[0]?.resolution
    assert.equal(settled?.kind, 'settled')
    assert.equal(settled.effect?.minute, 10)
    assert.equal(settled.effect?.state.revision, 1)
  } finally { await dispatcher.close(); await characters.close() }
})

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
