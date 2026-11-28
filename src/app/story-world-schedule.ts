import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { PlanStore } from '../story-workflow/store.js'
import { openStory } from '../story-workflow/story-query.js'
import { inspectStoryProgress } from '../story-workflow/progress.js'
import { openWorldScheduleStore, sceneScheduleReadiness, scheduledStateAt, scheduleDigest, scheduleSlotSchema, scheduledSceneIdentitySchema,
  type ScheduleBlock, type ScheduledScene, type ScheduleRoute, type ScheduleSlot, type WorldSchedule } from '../story-workflow/world-schedule.js'
import type { SceneSetupRecord, SceneResultRecord } from '../story-workflow/types.js'
import type { CharacterKnowledgeGrant } from '../story-workflow/character-participation.js'
import { interactionObservationContent } from '../story-workflow/scene-interaction.js'
import { currentScheduledScene, sceneExecutionScope, scheduledExperiencePrefix, type ScheduledExperience, type ScheduledScenePermit, type ScheduledSceneIdentity as SceneIdentity } from './story-schedule-context.js'
export type { ScheduledExperience, ScheduledScenePermit } from './story-schedule-context.js'
import { openStoryConvoyState, type AuthorizeConvoyChange } from './story-convoy-state.js'
import { openStoryEvents } from './story-event.js'
import { eventAssessmentEvidence, type StoryWorldProgressSource } from '../story-workflow/world-progress.js'

type Roots = Parameters<typeof openStory>[0]
type Window = WorldSchedule['window']
type Claim = NonNullable<ScheduledScene['claim']>

const ownedRoots = new Set<string>()
const ownedWorlds = new Set<string>()

/** 调度同一世界中各自拥有推进记录的故事运行。等待或演绎时不持有排期写入队列。 */
export async function openStoryWorldSchedule(roots: Roots, options: {
  worldId: string
  scheduleRoot: string
  maxConcurrent: number
  routeStillValid?(route: ScheduleRoute): Promise<boolean>
  endingPositions?(input: { slot: ScheduleSlot; scene: SceneSetupRecord; result: SceneResultRecord }): Promise<Window['positions']>
  allowExperience?(input: ScheduledExperience, destination: SceneIdentity & { runId: string }): Promise<boolean>
  convoy?: { convoyId: string; stateRoot: string; worldRoot: string; authorize?: AuthorizeConvoyChange }
}) {
  const { worldId, maxConcurrent, routeStillValid, endingPositions } = options
  if (!worldId.trim() || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('世界调度配置无效')
  const convoy = options.convoy && { ...options.convoy, stateRoot: await realpath(options.convoy.stateRoot) }
  const additionalRoots = convoy ? [convoy.stateRoot, convoy.worldRoot] : []
  const store = await openWorldScheduleStore(options.scheduleRoot, [roots.planRoot, roots.collaborationRoot, ...additionalRoots, ...roots.protectedRoots], worldId)
  const plans = await PlanStore.open(roots.planRoot, [roots.collaborationRoot, store.root, ...roots.protectedRoots])
  if (ownedRoots.has(store.root) || ownedWorlds.has(worldId)) throw new Error('该世界或排期根已有调度器')
  ownedRoots.add(store.root)
  ownedWorlds.add(worldId)
  const shutdown = new AbortController()
  const owner = {}
  const running = new Set<Promise<unknown>>()
  const waiters = new Set<() => void>()
  let tail = Promise.resolve()
  let closing: Promise<void> | undefined

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
  function live() { shutdown.signal.throwIfAborted() }
  async function convoyFor(runId: string) {
    if (!convoy) throw new Error('世界调度未绑定共享商队状态')
    return openStoryConvoyState(roots, { ...convoy, worldId, runId })
  }
  async function current() {
    const value = await store.latest()
    if (!value) throw new Error('世界尚未登记时间窗')
    return value
  }
  async function update(previous: WorldSchedule, window: Window, reason: string) {
    const saved = await store.save({ ...previous, revision: previous.revision + 1, previous: scheduleDigest(previous), reason, window })
    for (const wake of waiters) wake()
    return saved
  }
  function find(window: Window, slotId: string) {
    const slot = window.slots.find(item => item.id === slotId)
    if (!slot) throw new Error('排期不属于当前时间窗')
    return slot
  }
  function setSlot(window: Window, slot: ScheduledScene): Window {
    return { ...window, slots: window.slots.map(item => item.id === slot.id ? slot : item) }
  }
  function expect(value: WorldSchedule, revision: number) {
    if (value.revision !== revision) throw new Error('世界排期预期版本已变化')
  }
  async function validateRuns(slots: ScheduleSlot[]) {
    if (slots.some(slot => slot.targets.some(target => target.id !== convoy?.convoyId))) throw new Error('共享状态目标超出当前调度范围')
    for (const runId of new Set(slots.map(slot => slot.runId))) {
      const plan = await plans.read(runId)
      if (plan.formatVersion !== 2 || plan.input.world.worldId !== worldId || plan.outcome.kind !== 'planned') throw new Error('排期运行未绑定本世界的有效规划')
    }
  }
  async function sceneSource(slot: ScheduledScene, target: SceneIdentity) {
    const story = await openStory(roots, slot.runId, target.storyId)
    if (story.decision?.kind !== 'direct' || story.plan.formatVersion !== 2 || story.plan.input.world.worldId !== worldId) throw new Error('排期场景不属于本世界的直接演绎故事')
    const scene = await story.store.readSceneSetup(slot.runId, target.storyId, target.sceneId)
    if (scene.formatVersion === 2 && (scene.mapEvidence.worldId !== worldId || scene.mapEvidence.deliveryId !== story.plan.input.world.deliveryId ||
      scene.mapEvidence.deliveryVersion !== story.plan.input.world.deliveryVersion)) throw new Error('排期场景的世界资料版本不匹配')
    return { store: story.store, scene }
  }
  async function readiness(window: Window, slot: ScheduledScene) {
    const { blocks, routes } = sceneScheduleReadiness(window, slot)
    if (routeStillValid) {
      for (const route of routes) {
        if (!await routeStillValid(structuredClone(route))) {
          const characterId = slot.characters.find(id => sceneScheduleReadiness(window, { ...slot, characters: [id] }).routes.includes(route))!
          blocks.push({ kind: 'route-version', characterId, from: route.from, to: route.to })
        }
      }
    }
    const state = slot.targets.length ? scheduledStateAt(window, slot.start) : undefined
    if (!blocks.length && slot.targets.length) {
      let verified = false
      try { verified = !!state && isDeepStrictEqual(await (await convoyFor(slot.runId)).progress.current(), state) }
      catch { /* 只读视图仍须列出可独立推进的场景。 */ }
      if (!verified) blocks.push({ kind: 'state-unverified', targetId: slot.targets[0]!.id })
    }
    return { blocks, routes, state }
  }
  function wait(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => { waiters.delete(wake); signal.removeEventListener('abort', abort) }
      const wake = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(signal.reason) }
      waiters.add(wake)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  const queued = new Set<string>()
  async function acquire(slotId: string, identity: SceneIdentity, signal: AbortSignal, recover: boolean) {
    for (;;) {
      const result = await exclusive(async () => {
        signal.throwIfAborted()
        const previous = await current()
        const { window } = previous
        const slot = find(window, slotId)
        const active = window.slots.filter(item => item.claim && executing.has(item.claim.token))
        if (recover && slot.claim && slot.resolution?.kind !== 'settled' && slot.resolution?.kind !== 'cancelled') {
          const { claim } = slot
          if (executing.has(claim.token) || claim.storyId !== identity.storyId || claim.sceneId !== identity.sceneId) throw new Error('排期无法接管现有场景领取')
          if (active.length >= maxConcurrent || active.some(item => item.runId === slot.runId)) return { waiting: wait(signal) }
          const { scene } = await sceneSource(slot, identity)
          if (scheduleDigest(scene) !== claim.setupDigest) throw new Error('接管场景的设置已变化')
          signal.throwIfAborted()
          const { resolution: _, ...reopened } = slot
          await update(previous, setSlot(window, reopened), '接管已有场景领取')
          executing.add(claim.token)
          return { slot: reopened, claim }
        }
        if (slot.claim || slot.resolution) throw new Error('排期已经领取或取消，请核查保存的进度')
        const { blocks, routes, state } = await readiness(window, slot)
        if (blocks.length || active.length >= maxConcurrent || active.some(item => item.runId === slot.runId)) return { waiting: wait(signal) }
        const prior = window.slots.filter(item => queued.has(item.id) && item.id !== slot.id && !item.claim && !item.resolution &&
          (item.start < slot.start || (item.start === slot.start && item.id < slot.id)))
        for (const candidate of prior) {
          if (!active.some(item => item.runId === candidate.runId) && !(await readiness(window, candidate)).blocks.length) return { waiting: wait(signal) }
        }
        const { scene, store: records } = await sceneSource(slot, identity)
        if (await records.readSceneResult(scene) || (await records.listCharacterParticipationIds(slot.runId, identity.storyId, identity.sceneId)).length) {
          throw new Error('场景已存在演绎记录，无法领取空白排期')
        }
        const claim = { ...identity, setupDigest: scheduleDigest(scene), token: randomUUID(), routes, ...(state ? { state } : {}) }
        signal.throwIfAborted()
        await update(previous, setSlot(window, { ...slot, claim }), '独占领取场景排期')
        executing.add(claim.token)
        return { slot, claim }
      })
      if (result.slot) return { slot: result.slot, claim: result.claim }
      await result.waiting
    }
  }
  const executing = new Set<string>()
  async function experiences(slot: ScheduleSlot, identity: SceneIdentity, characterId: string) {
    const { allowExperience } = options
    if (!allowExperience) return []
    const authorize = allowExperience
    const { window } = await current()
    const earlier = window.slots.filter(item => item.end <= slot.start && item.characters.includes(characterId) && item.resolution?.kind === 'settled')
      .sort((left, right) => left.end - right.end)
    const grants = new Map<string, CharacterKnowledgeGrant>()
    for (const previous of earlier) {
      const claim = previous.claim!
      const { store: records, scene } = await sceneSource(previous, claim)
      const result = await records.readSceneResult(scene)
      if (scheduleDigest(scene) !== claim.setupDigest || !result || previous.resolution?.kind !== 'settled' ||
        scheduleDigest(result) !== previous.resolution.evidenceDigest) throw new Error('跨故事经历的场景结算证据已变化')
      if (result.formatVersion !== 2) continue
      const { storyId, sceneId } = claim
      const source = { worldId, runId: previous.runId, storyId, sceneId, minute: previous.end }
      async function add(reference: string, kind: ScheduledExperience['kind'], content: string, evidence: unknown) {
        const version = scheduleDigest([result, evidence])
        const item = { source, characterId, kind, content, version }
        if (!await authorize(structuredClone(item), { ...identity, runId: slot.runId })) return
        const id = `${scheduledExperiencePrefix}${window.id}:${previous.id}:${reference}`
        grants.set(id, { characterId, sceneId: identity.sceneId, category: 'known', content,
          basis: `第 ${source.minute} 分钟前在所属场景亲历的${kind === 'action' ? '已确认行动' : '观察'}`,
          source: { kind: 'fixed', id, version } })
      }
      for (const event of await records.listInteractionEvents(previous.runId, storyId, sceneId)) {
        const [decision, actions] = await Promise.all([records.readInteractionDecision(event), records.readInteractionActions(event)])
        const perception = decision?.perceptions.find(item => item.characterId === characterId)
        for (const [index, observation] of (perception?.observations ?? []).entries()) {
          await add(`${event.sequence}:observation:${index}`, 'observation', interactionObservationContent(observation), [event, decision])
        }
        if (event.characterId !== characterId) continue
        for (const action of actions?.outcomes ?? []) {
          if (action.status === 'succeeded') await add(`${event.sequence}:action:${action.index}`, 'action', action.observable ?? event.actions[action.index]!, [event, actions])
        }
      }
    }
    return [...grants.values()]
  }
  async function settle(slotId: string, claim: Claim) {
    const previous = await current()
    const slot = find(previous.window, slotId)
    if (!isDeepStrictEqual(slot.claim, claim) || slot.resolution?.kind === 'cancelled') throw new Error('场景领取版本已变化')
    const { store: records, scene } = await sceneSource(slot, claim)
    if (scheduleDigest(scene) !== claim.setupDigest) throw new Error('场景设置已变化')
    const result = await records.readSceneResult(scene)
    if (!result || result.status === 'unresolved') throw new Error('场景没有可核对的结算结果')
    const events = await records.listInteractionEvents(slot.runId, scene.storyId, scene.sceneId)
    for (const event of events) {
      const actions = await records.readInteractionActions(event)
      if (actions?.outcomes.some(action => action.status === 'unresolved')) throw new Error('场景仍有未确定的角色行动')
    }
    for (const id of await records.listCharacterParticipationIds(slot.runId, scene.storyId, scene.sceneId)) {
      const participation = await records.readCharacterParticipation(slot.runId, scene.storyId, scene.sceneId, id)
      if (!slot.characters.includes(participation.claim.request.characterId) || participation.result?.outcome.status !== 'responded') {
        throw new Error('场景存在未获准或没有确定结果的角色参与')
      }
      if (participation.result.outcome.response.kind === 'respond' && !events.some(event => event.participationId === id)) {
        throw new Error('角色发言或行动尚未进入场景互动记录')
      }
    }
    const positions = endingPositions ? await endingPositions({ slot: scheduleSlotSchema.parse(slotWithoutProgress(slot)), scene, result }) :
      slot.characters.map(characterId => ({ characterId, locationId: slot.locationId }))
    const effect = slot.resolution?.kind === 'settled' ? slot.resolution.effect : await stateEffect(slot, claim)
    const resolution = { kind: 'settled', positions, evidenceDigest: scheduleDigest(result), ...(effect ? { effect } : {}) } as const
    if (slot.resolution?.kind === 'settled') {
      if (effect && !isDeepStrictEqual(effect, await stateEffect(slot, claim))) throw new Error('已结算的商队回执已变化')
      if (!isDeepStrictEqual(slot.resolution, resolution)) throw new Error('场景结算证据已变化')
      return previous
    }
    return update(previous, setSlot(previous.window, { ...slot, resolution }), '核对结算并结束场景排期')
  }
  async function stateEffect(slot: ScheduledScene, claim: Claim) {
    if (!claim.state) return undefined
    const state = await convoyFor(slot.runId)
    const actual = await state.progress.current()
    if (isDeepStrictEqual(actual, claim.state)) return undefined
    if (actual.status !== 'waiting' || !slot.targets.some(target => target.id === actual.convoyId && target.mode === 'write')) {
      throw new Error('当前商队版本或场景写入权限不匹配')
    }
    const change = await state.readChange(actual.operationId)
    const { evidence } = change.proposal
    const receipt = await state.inspect(actual.operationId)
    if (change.expectedDigest !== claim.state.digest || evidence.runId !== slot.runId || evidence.storyId !== claim.storyId || evidence.sceneId !== claim.sceneId ||
      receipt.status !== 'applied') throw new Error('商队回执与领取场景或准入版本不匹配')
    return { minute: slot.end, state: actual }
  }
  function slotWithoutProgress({ claim: _claim, resolution: _resolution, ...slot }: ScheduledScene): ScheduleSlot { return slot }
  return Object.freeze({
    latest: store.latest, read: store.read,
    /** 从排期有效时刻读取导演可用的商队状态，事件访问仍绑定本运行。 */
    progress(runId: string, signal?: AbortSignal): StoryWorldProgressSource {
      const events = openStoryEvents(roots, { worldId, runId })
      const activeSignal = signal ? AbortSignal.any([shutdown.signal, signal]) : shutdown.signal
      return Object.freeze({ worldId, runId,
        async current() {
          activeSignal.throwIfAborted()
          const permit = currentScheduledScene()
          if (permit && convoy) return permit.readConvoy(convoy.stateRoot, worldId, runId, convoy.convoyId)
          for (;;) {
            const snapshot = await exclusive(async () => {
              activeSignal.throwIfAborted()
              const { window } = await current()
              const slots = window.slots.filter(slot => slot.runId === runId && slot.targets.length > 0)
              if (!slots.length) throw new Error('该运行在当前时间窗没有获准的商队状态')
              const completions = slots.filter(slot => slot.resolution?.kind === 'settled').map(slot => slot.end)
              const time = completions.length ? Math.max(...completions) : Math.min(...slots.map(slot => slot.start))
              if (window.slots.some(slot => slot.end <= time && slot.targets.some(target => target.mode === 'write') &&
                slot.resolution?.kind !== 'settled' && slot.resolution?.kind !== 'cancelled')) return { waiting: wait(activeSignal) }
              const state = scheduledStateAt(window, time)
              if (!state) throw new Error('该时间窗没有获准读取的商队版本')
              const handle = await convoyFor(runId)
              const actual = state.status === 'waiting' ? await handle.progress.current() : await handle.initialEvidence()
              if (!isDeepStrictEqual(actual, state)) throw new Error('当前排期的商队证据已变化')
              return { state }
            })
            if (snapshot.state) return snapshot.state
            await snapshot.waiting
          }
        },
        async event(storyId: string, sceneId: string) {
          const event = await events.read({ runId, storyId, sceneId })
          return eventAssessmentEvidence(event, scheduleDigest(event))
        },
      })
    },
    async view() {
      const { window, revision } = await current()
      const reviews = new Map<string, ReturnType<typeof inspectStoryProgress>>()
      return { revision, windowId: window.id, slots: await Promise.all(window.slots.map(async slot => {
        const blocks: ScheduleBlock[] = slot.resolution || slot.claim ? [] : (await readiness(window, slot)).blocks
        let review
        if (!slot.resolution && !slot.claim) {
          const pending = reviews.get(slot.runId) ?? inspectStoryProgress(roots, slot.runId)
          reviews.set(slot.runId, pending)
          const progress = await pending
          if (progress.status === 'awaiting-review' || progress.status === 'review-ready' || progress.status === 'review-cancelled') {
            review = { status: progress.status, batch: progress.batch }
          }
        }
        const status = slot.resolution?.kind ?? (slot.claim ? (executing.has(slot.claim.token) ? 'running' : 'uncertain') : blocks.length || review ? 'waiting' : 'ready')
        return { ...slot, status, blocks, ...(review ? { review } : {}) }
      })) }
    },
    openWindow(input: { id: string; start: number; end: number; epoch: string; positions: Window['positions']; routes: ScheduleRoute[] }, expectedRevision = -1) {
      return exclusive(async () => {
        live()
        const previous = await store.latest()
        const { epoch, ...window } = structuredClone(input)
        const baseline = convoy ? await (await convoyFor(window.id)).progress.current() : undefined
        const draft = { ...window, sealed: false, slots: [], ...(baseline ? { baseline } : {}) }
        if (!previous) {
          if (expectedRevision !== -1) throw new Error('世界排期预期版本已变化')
          return store.save({ formatVersion: 1, worldId, epoch, revision: 0, previous: null, reason: '登记时间窗', window: draft })
        }
        expect(previous, expectedRevision)
        if (epoch !== previous.epoch || window.id === previous.window.id || window.start < previous.window.end ||
          !previous.window.sealed || previous.window.slots.some(item => !item.resolution || item.resolution.kind === 'uncertain')) throw new Error('前一世界时间窗尚未完成或时间基准无效')
        if (!isDeepStrictEqual(baseline, scheduledStateAt(previous.window, previous.window.end))) throw new Error('商队状态与上一时间窗的已确认版本不符')
        const positions = new Map(previous.window.positions.map(item => [item.characterId, item]))
        for (const slot of [...previous.window.slots].sort((left, right) => left.end - right.end)) {
          if (slot.resolution?.kind === 'settled') for (const item of slot.resolution.positions) positions.set(item.characterId, item)
        }
        for (const position of window.positions) {
          const prior = positions.get(position.characterId)
          if (prior && !isDeepStrictEqual(prior, position)) throw new Error('新时间窗起始位置与已确认位置不符')
          positions.set(position.characterId, position)
        }
        return update(previous, { ...draft, positions: [...positions.values()] }, '登记下一时间窗')
      })
    },
    revise(expectedRevision: number, input: { slots: ScheduleSlot[]; reason: string; routes?: ScheduleRoute[]; seal?: boolean }) {
      const draft = structuredClone(input)
      return exclusive(async () => {
        live()
        const previous = await current()
        expect(previous, expectedRevision)
        const slots: ScheduledScene[] = draft.slots.map(slot => scheduleSlotSchema.parse(slot))
        await validateRuns(slots)
        const started = previous.window.slots.filter(slot => slot.claim || slot.resolution)
        for (const prior of started) {
          const index = slots.findIndex(slot => slot.id === prior.id)
          if (index < 0 || !isDeepStrictEqual(slots[index], slotWithoutProgress(prior))) throw new Error('已领取或结算的排期不可修改')
          slots[index] = prior
        }
        for (const slot of slots.filter(item => !item.claim && !item.resolution)) {
          const prior = previous.window.slots.find(item => item.id === slot.id)
          if (isDeepStrictEqual(slot, prior)) continue
          if (started.some(item => item.claim && item.start >= slot.start && (item.runId === slot.runId || item.characters.some(id => slot.characters.includes(id)) ||
            item.targets.some(target => slot.targets.some(other => other.id === target.id))))) throw new Error('排期修订会回填已领取场景的前置范围')
        }
        return update(previous, { ...previous.window, slots, routes: draft.routes ?? previous.window.routes, sealed: previous.window.sealed || !!draft.seal }, draft.reason)
      })
    },
    cancel(slotId: string, expectedRevision: number, reason: string) {
      return exclusive(async () => {
        live()
        const previous = await current()
        expect(previous, expectedRevision)
        const slot = find(previous.window, slotId)
        if (slot.claim || slot.resolution) throw new Error('只有尚未领取的排期可直接取消')
        return update(previous, setSlot(previous.window, { ...slot, resolution: { kind: 'cancelled', reason } }), reason)
      })
    },
    execute<T>(slotId: string, target: SceneIdentity, run: (permit: ScheduledScenePermit, signal: AbortSignal) => Promise<T>, signal?: AbortSignal, recover = false): Promise<T> {
      live()
      if (queued.has(slotId)) throw new Error('排期已有等待的演绎请求')
      const identity = Object.freeze(scheduledSceneIdentitySchema.parse(target))
      const activeSignal = signal ? AbortSignal.any([shutdown.signal, signal]) : shutdown.signal
      queued.add(slotId)
      const execution = (async () => {
        const { slot, claim } = await acquire(slotId, identity, activeSignal, recover).finally(() => {
          queued.delete(slotId)
          for (const wake of waiters) wake()
        })
        let permitActive = true
        const assertActive = () => {
          activeSignal.throwIfAborted()
          if (!permitActive) throw new Error('场景排期许可已结束')
        }
        const permit: ScheduledScenePermit = Object.freeze<ScheduledScenePermit>({
          slot: Object.freeze(structuredClone(slotWithoutProgress(slot))), identity,
          ...(claim.state ? { state: Object.freeze(structuredClone(claim.state)) } : {}),
          assertActive,
          assertScene(sceneId, runId, storyId) {
            assertActive()
            if (runId !== slot.runId || sceneId !== identity.sceneId || storyId !== identity.storyId) throw new Error('场景超出当前排期许可')
          },
          assertCharacter(characterId: string, sceneId: string, runId: string, storyId: string) {
            assertActive()
            if (runId !== slot.runId || sceneId !== identity.sceneId || storyId !== identity.storyId ||
              !slot.characters.includes(characterId)) throw new Error('角色调用超出当前排期许可')
          },
          async experiences(characterId: string) {
            permit.assertCharacter(characterId, identity.sceneId, slot.runId, identity.storyId)
            const grants = await experiences(slot, identity, characterId)
            assertActive()
            return grants
          },
          assertConvoyWrite(stateRoot, proposal) {
            const start = permit.readConvoy(stateRoot, proposal.worldId, proposal.evidence.runId, proposal.convoyId)
            if (!slot.targets.some(target => target.id === proposal.convoyId && target.mode === 'write') ||
              proposal.evidence.storyId !== identity.storyId || proposal.evidence.sceneId !== identity.sceneId ||
              proposal.expectedRevision !== start.revision) throw new Error('商队写入超出当前排期或准入版本')
          },
          readConvoy(stateRoot, requestedWorldId, runId, convoyId) {
            assertActive()
            const state = permit.state
            if (!state || stateRoot !== convoy?.stateRoot || requestedWorldId !== worldId || runId !== slot.runId || convoyId !== state.convoyId) {
              throw new Error('商队读取超出当前排期许可')
            }
            return state
          },
        })
        try {
          activeSignal.throwIfAborted()
          const value = await sceneExecutionScope.run({ owner, permit }, () => run(permit, activeSignal))
          permitActive = false
          await exclusive(() => settle(slotId, claim))
          return value
        } catch (error) {
          await exclusive(async () => {
            const previous = await current()
            const owned = find(previous.window, slotId)
            if (!owned.resolution && owned.claim?.token === claim.token) {
              const reason = error instanceof Error ? error.message : String(error)
              await update(previous, setSlot(previous.window, { ...owned, resolution: { kind: 'uncertain', reason } }), '场景执行结果待核查')
            }
          }).catch(failure => { throw new AggregateError([error, failure], '场景执行和待核查记录保存失败') })
          throw error
        } finally {
          permitActive = false
          executing.delete(claim.token)
          for (const wake of waiters) wake()
        }
      })()
      running.add(execution)
      const release = () => { running.delete(execution) }
      void execution.then(release, release)
      return execution
    },
    reconcile(slotId: string, choice: { kind: 'settle' } | { kind: 'cancel-empty'; reason: string } = { kind: 'settle' }) {
      return exclusive(async () => {
        live()
        const previous = await current()
        const slot = find(previous.window, slotId)
        if (!slot.claim || executing.has(slot.claim.token)) throw new Error('排期尚无可核查的离线领取')
        if (choice.kind === 'cancel-empty') {
          const { scene, store: records } = await sceneSource(slot, slot.claim)
          if (slot.resolution?.kind === 'settled' || scheduleDigest(scene) !== slot.claim.setupDigest || await records.readSceneResult(scene) ||
            (await records.listCharacterParticipationIds(slot.runId, scene.storyId, scene.sceneId)).length ||
            (await records.listInteractionEvents(slot.runId, scene.storyId, scene.sceneId)).length) throw new Error('排期已有业务记录或设置变化，不能作为空场景取消')
          return update(previous, setSlot(previous.window, { ...slot, resolution: { kind: 'cancelled', reason: choice.reason } }), choice.reason)
        }
        return settle(slotId, slot.claim)
      })
    },
    close() {
      if (sceneExecutionScope.getStore()?.owner === owner) throw new Error('场景执行回调不能关闭所属世界调度器')
      return closing ??= (async () => {
        shutdown.abort(new Error('世界调度器已关闭'))
        await Promise.allSettled(running)
        await tail
        ownedRoots.delete(store.root)
        ownedWorlds.delete(worldId)
      })()
    },
  })
}
