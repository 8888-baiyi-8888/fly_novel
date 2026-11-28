import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CharacterStore } from '@fly-novel/character'
import type { StorySimulationInput } from '../story-workflow/simulation.js'
import type { StoryPlanningOptions } from '../story-workflow/workflow.js'
import { characterParticipationRequestSchema, type CharacterKnowledgeGrant } from '../story-workflow/character-participation.js'
import { simulationSchema, type SceneSetupRecord, type Simulation } from '../story-workflow/types.js'
import { openStory, readIfPresent } from '../story-workflow/story-query.js'
import { convoyProposalSchema } from '../story-workflow/convoy-state.js'
import { runDigest, storyRunDigestSchema, storyRunIdSchema, type openStoryRunRecords } from '../story-workflow/run-records.js'
import type { SceneEvent } from '../story-workflow/scene-event.js'
import { openStoryConvoyState, type AuthorizeConvoyChange } from './story-convoy-state.js'
import type { openStoryWorldSchedule } from './story-world-schedule.js'
import type { StoryCharacterConfig } from './story-character-runtime.js'
import type { bindStoryWorld } from './story-world-materials.js'
import {
  bindStoryCharacters, createStoryScene, createStorySceneWithMap, inspectStoryMapScene, openStoryCharacterRuntime,
  openStoryEvents, openStorySceneInteraction, requestStoryMapProposal, runStorySceneInteraction, selectStoryCharacters,
  readStoryMapCheck, readStoryMapProposal,
  type SceneInteractionConditions, type SceneWorldRuleJudge, type StoryCharacterCandidate, type StoryMapScope,
} from './story-workflow.js'

type Roots = Parameters<typeof createStoryScene>[0]
type Binding = Awaited<ReturnType<typeof bindStoryWorld>>
type Director = Pick<StoryPlanningOptions, 'provider' | 'model' | 'adapter'>
type MapReview = NonNullable<Parameters<typeof createStorySceneWithMap>[6]>
type Identity = Pick<StorySimulationInput, 'runId' | 'storyId' | 'task' | 'preparation' | 'mapNeed'>
type Records = Awaited<ReturnType<typeof openStoryRunRecords>>
const convoyIntent = z.union([z.literal('no-change'), convoyProposalSchema])
const finishedScene = z.object({ sceneId: z.string().min(1), result: storyRunDigestSchema, eventId: storyRunDigestSchema }).strict()
const adoption = z.object({ version: storyRunDigestSchema, decision: z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), actor: z.string().trim().min(1), reason: z.string().trim().min(1) }).strict(),
  z.object({ status: z.literal('rejected'), reason: z.string().trim().min(1) }).strict(),
]) }).strict()

export interface StoryRunSceneOptions {
  characters: {
    store: CharacterStore
    ownerAgentId: string
    configure(characterId: string): StoryCharacterConfig
  }
  /** 可信应用为当前最小故事提供一个场景、候选、感知条件和认知授权。 */
  prepare(input: Identity): Promise<{
    candidates: readonly StoryCharacterCandidate[]
    initialCandidates: readonly string[]
    grants(characterId: string, scene: SceneSetupRecord): Promise<readonly CharacterKnowledgeGrant[]>
    conditions(scene: SceneSetupRecord, sequence: number, participationId: string): Promise<SceneInteractionConditions>
    allowObservation: Parameters<ReturnType<typeof openStorySceneInteraction>['dispatch']>[4]
    judge?: SceneWorldRuleJudge
  }>
  maxEvents: number
  map?: { scope: StoryMapScope; model: Director & { timeoutMs: number }; review: MapReview }
  convoy?: {
    convoyId: string
    stateRoot: string
    worldRoot: string
    authorize: AuthorizeConvoyChange
    selectChange(event: SceneEvent): Promise<{ sequence: number; actionIndex: number; locationId: string } | undefined>
  }
  schedule?: {
    handle: Awaited<ReturnType<typeof openStoryWorldSchedule>>
    slot(input: Identity): Promise<string>
    version: string
  }
}

export async function readManagedConvoyReceipt(records: Records, managedId: string, roots: Roots, worldId: string, runId: string, storyId: string,
  config: NonNullable<StoryRunSceneOptions['convoy']>) {
  const intent = await records.read(managedId, `scene.${storyId}.convoy`, convoyIntent)
  if (!intent || intent === 'no-change') return undefined
  if (intent.worldId !== worldId || intent.convoyId !== config.convoyId || intent.evidence.runId !== runId || intent.evidence.storyId !== storyId) {
    throw new Error('场景状态操作与运行归属不匹配')
  }
  const state = await openStoryConvoyState(roots, { ...config, worldId, runId })
  const receipt = await state.inspect(intent.operationId)
  return { operationId: intent.operationId, eventId: intent.evidence.eventId, status: receipt.status,
    ...(receipt.status === 'applied' ? { revision: receipt.state.revision } : {}) }
}

/** 使用现有受权入口驱动一个可结算的最小场景。 */
export async function runManagedScene(records: Records, managedId: string, roots: Roots, binding: Binding, director: Director, config: StoryRunSceneOptions,
  input: StorySimulationInput, signal: AbortSignal): Promise<Simulation> {
  const { runId, storyId, task, preparation, mapNeed } = input
  const identity = { runId, storyId, task, preparation, ...(mapNeed ? { mapNeed } : {}) }
  const step = (name: string) => `scene.${storyId}.${name}`
  const { store: collaboration } = await openStory(roots, runId, storyId)
  const existing = await collaboration.listSceneSetups(runId, storyId)
  if (existing.length > 1) throw new Error('正式运行无法确认最小场景边界')
  const setup = { order: 1, situation: task.background, preparation }
  let scene: SceneSetupRecord
  if (existing[0]) {
    scene = existing[0]
    if (scene.order !== 1 || scene.situation !== setup.situation || scene.preparation !== setup.preparation) throw new Error('已保存场景设置与恢复输入不匹配')
  } else if (mapNeed) {
    const map = config.map
    if (!map) throw new Error('场景需要可信地图装配')
    const checkId = await records.read(managedId, step('map'), storyRunIdSchema) ??
      await records.save(managedId, step('map'), storyRunIdSchema, randomUUID())
    const check = await readIfPresent(readStoryMapCheck(roots, runId, storyId, checkId)) ??
      await inspectStoryMapScene(roots, runId, storyId, map.scope, mapNeed, signal, checkId)
    if (check.result.status === 'missing' && !await readIfPresent(readStoryMapProposal(roots, runId, storyId, checkId))) {
      await requestStoryMapProposal(roots, runId, storyId, checkId, map.scope, map.model, signal)
    }
    scene = await createStorySceneWithMap(roots, runId, storyId, check.id, map.scope, setup, async evidence => {
      const version = runDigest(evidence)
      const saved = await records.read(managedId, step('map-adoption'), adoption)
      if (saved) {
        if (saved.version !== version) throw new Error('已保存的地图审阅依据已变化')
        return saved.decision
      }
      const decision = await map.review(evidence)
      signal.throwIfAborted()
      return (await records.save(managedId, step('map-adoption'), adoption, { version, decision })).decision
    }, signal)
  } else {
    scene = await createStoryScene(roots, runId, storyId, setup)
  }
  const { sceneId } = scene
  const target = { runId, storyId, sceneId }
  const events = openStoryEvents(roots, { worldId: binding.world.worldId, runId })
  async function settle(active: AbortSignal, simulation: Simulation) {
    const event = await readIfPresent(events.read(target)) ?? await events.adopt(target)
    if (config.convoy) {
      const { selectChange, ...settings } = config.convoy
      const state = await openStoryConvoyState(roots, { ...settings, worldId: binding.world.worldId, runId })
      let intent = await records.read(managedId, step('convoy'), convoyIntent)
      if (intent === undefined) {
        const selected = await selectChange(structuredClone(event))
        active.throwIfAborted()
        intent = await records.save(managedId, step('convoy'), convoyIntent, selected ? {
          worldId: state.worldId, convoyId: state.convoyId, operationId: randomUUID(),
          expectedRevision: (await state.progress.current()).revision, locationId: selected.locationId,
          evidence: { ...target, eventId: event.eventId, sequence: selected.sequence, actionIndex: selected.actionIndex },
        } : 'no-change')
      }
      if (intent !== 'no-change') {
        if (intent.evidence.sceneId !== sceneId || intent.evidence.storyId !== storyId || intent.evidence.runId !== runId ||
          intent.evidence.eventId !== event.eventId || intent.worldId !== state.worldId || intent.convoyId !== state.convoyId) throw new Error('恢复状态操作的证据不匹配')
        const receipt = await state.inspect(intent.operationId)
        const applied = receipt.status === 'not-applied' ? (await state.prepare(intent), await state.apply(intent.operationId, active)) : receipt
        if (applied.status !== 'applied') throw new Error(`商队状态回执待核查：${applied.status}`)
        const change = await state.readChange(intent.operationId)
        if (runDigest(change.proposal) !== runDigest(intent) || runDigest(applied.state.change) !== runDigest(change)) throw new Error('商队已应用的操作与意图不匹配')
      }
    }
    const saved = await collaboration.readSceneResult(scene)
    if (!saved || saved.status === 'unresolved' || runDigest(saved.simulation) !== runDigest(simulation)) throw new Error('模拟结束缺少已核对的场景结果')
    await records.save(managedId, step('completed'), finishedScene, { sceneId, result: runDigest(saved), eventId: event.eventId })
    return saved.simulation
  }
  async function simulate(active: AbortSignal) {
    const result = await collaboration.readSceneResult(scene)
    if (result) {
      if (result.status === 'unresolved') throw new Error('已有场景结果待核查')
      return settle(active, result.simulation)
    }
    const available = await config.prepare(identity)
    const { ownerAgentId, store, configure } = config.characters
    const scope = bindStoryCharacters(roots, target, { binding, ownerAgentId, store, candidates: available.candidates })
    const runtime = await openStoryCharacterRuntime(scope, configure)
    try {
      let request = await records.read(managedId, step('initial'), characterParticipationRequestSchema)
      if (!request) {
        if ((await collaboration.listCharacterParticipationIds(runId, storyId, sceneId)).length) throw new Error('场景已有参与记录但缺少首回合意图')
        const requests = await selectStoryCharacters(scope, sceneId, available.initialCandidates, director, active)
        if (requests.length !== 1) throw new Error('完整运行的首个回合须选择一名已授权角色')
        request = await records.save(managedId, step('initial'), characterParticipationRequestSchema, requests[0]!)
      }
      if (request.sceneId !== sceneId || !available.initialCandidates.includes(request.characterId)) throw new Error('恢复首回合超出已授权场景或角色')
      const original = await readIfPresent(collaboration.readCharacterParticipation(runId, storyId, sceneId, request.participationId))
      if (original && runDigest(original.claim.request) !== runDigest(request)) throw new Error('恢复的首回合参与记录不匹配')
      const initial = original ? original.result : await runtime.respond(await scope.restore(request), await available.grants(request.characterId, scene), active)
      if (initial?.outcome.status !== 'responded') throw new Error('初始角色响应待核查')
      const interaction = openStorySceneInteraction(roots, target)
      const progress = await runStorySceneInteraction(interaction, {
        initialParticipationId: request.participationId, director, scope, runtime,
        conditions: (sequence, id) => available.conditions(scene, sequence, id),
        grants: characterId => available.grants(characterId, scene), allowObservation: available.allowObservation,
        judge: available.judge, maxEvents: config.maxEvents, recoverUnstartedDispatch: true,
      }, active)
      if (progress.status !== 'end') throw new Error(`互动尚未结束：${progress.status}`)
      const trace = await interaction.trace()
      const actions = trace.flatMap(item => item.actions?.outcomes ?? [])
      const simulation = simulationSchema.parse({
        kind: 'simulation', summary: `场景已结算：${scene.situation}`,
        changes: actions.flatMap(action => action.status === 'succeeded' && action.observable ? [action.observable] : []),
        unresolved: actions.filter(action => action.status === 'unresolved').map(action => action.reason),
        evidence: `${sceneId} 的互动记录，共 ${trace.length} 项`,
      })
      await input.recordSceneResult(sceneId, { status: 'completed', simulation })
      return settle(active, simulation)
    } finally { await runtime.close() }
  }
  if (!config.schedule) return simulate(signal)
  const { handle } = config.schedule
  const slotId = await records.read(managedId, step('slot'), storyRunIdSchema) ??
    await records.save(managedId, step('slot'), storyRunIdSchema, await config.schedule.slot(identity))
  const scheduled = (await handle.latest())?.window.slots.find(slot => slot.id === slotId)
  if (scheduled?.runId !== runId) throw new Error('恢复排期与故事运行不匹配')
  if (scheduled.resolution?.kind === 'settled') {
    const marker = await records.read(managedId, step('completed'), finishedScene)
    const result = await collaboration.readSceneResult(scene)
    if (!marker || !result || marker.sceneId !== sceneId || marker.result !== runDigest(result) ||
      marker.eventId !== (await events.read(target)).eventId) throw new Error('已结算排期缺少完整模拟结束证据')
    await handle.reconcile(slotId)
    return result.simulation
  }
  return handle.execute(slotId, { storyId, sceneId }, (_, active) => simulate(active), signal, !!scheduled.claim)
}
