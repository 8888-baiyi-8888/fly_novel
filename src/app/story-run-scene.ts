import type { CharacterStore } from '@fly-novel/character'
import type { StorySimulationInput } from '../story-workflow/simulation.js'
import type { StoryPlanningOptions } from '../story-workflow/workflow.js'
import type { CharacterKnowledgeGrant } from '../story-workflow/character-participation.js'
import type { SceneSetupRecord, Simulation } from '../story-workflow/types.js'
import type { openStoryWorldSchedule } from './story-world-schedule.js'
import type { StoryCharacterConfig } from './story-character-runtime.js'
import type { bindStoryWorld } from './story-world-materials.js'
import {
  bindStoryCharacters, createStoryScene, createStorySceneWithMap, inspectStoryMapScene, openStoryCharacterRuntime,
  openStoryEvents, openStorySceneInteraction, requestStoryMapProposal, runStorySceneInteraction, selectStoryCharacters,
  type SceneInteractionConditions, type SceneWorldRuleJudge, type StoryCharacterCandidate, type StoryMapScope,
} from './story-workflow.js'

type Roots = Parameters<typeof createStoryScene>[0]
type Binding = Awaited<ReturnType<typeof bindStoryWorld>>
type Director = Pick<StoryPlanningOptions, 'provider' | 'model' | 'adapter'>
type MapReview = NonNullable<Parameters<typeof createStorySceneWithMap>[6]>
type Identity = Pick<StorySimulationInput, 'runId' | 'storyId' | 'task' | 'preparation' | 'mapNeed'>

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
  schedule?: {
    handle: Awaited<ReturnType<typeof openStoryWorldSchedule>>
    slot(input: Identity): Promise<string>
    version: string
  }
}

/** 使用现有受权入口驱动一个可结算的最小场景。 */
export async function runManagedScene(roots: Roots, binding: Binding, director: Director, config: StoryRunSceneOptions,
  input: StorySimulationInput, signal: AbortSignal): Promise<Simulation> {
  const { runId, storyId, task, preparation, mapNeed } = input
  const identity = { runId, storyId, task, preparation, ...(mapNeed ? { mapNeed } : {}) }
  const available = await config.prepare(identity)
  const setup = { order: 1, situation: task.background, preparation }
  let scene: SceneSetupRecord
  if (mapNeed) {
    const map = config.map
    if (!map) throw new Error('场景需要可信地图装配')
    const check = await inspectStoryMapScene(roots, runId, storyId, map.scope, mapNeed, signal)
    if (check.result.status === 'missing') await requestStoryMapProposal(roots, runId, storyId, check.id, map.scope, map.model, signal)
    scene = await createStorySceneWithMap(roots, runId, storyId, check.id, map.scope, setup, map.review, signal)
  } else {
    scene = await createStoryScene(roots, runId, storyId, setup)
  }
  const { sceneId } = scene
  const target = { runId, storyId, sceneId }
  async function simulate(active: AbortSignal) {
    const { ownerAgentId, store, configure } = config.characters
    const scope = bindStoryCharacters(roots, target, { binding, ownerAgentId, store, candidates: available.candidates })
    const runtime = await openStoryCharacterRuntime(scope, configure)
    try {
      const requests = await selectStoryCharacters(scope, sceneId, available.initialCandidates, director, active)
      if (requests.length !== 1) throw new Error('完整运行的首个回合须选择一名已授权角色')
      const request = requests[0]!
      const initial = await runtime.respond(request, await available.grants(request.characterId, scene), active)
      if (initial.outcome.status !== 'responded') throw new Error('初始角色响应待核查')
      const interaction = openStorySceneInteraction(roots, target)
      const progress = await runStorySceneInteraction(interaction, {
        initialParticipationId: request.participationId, director, scope, runtime,
        conditions: (sequence, id) => available.conditions(scene, sequence, id),
        grants: characterId => available.grants(characterId, scene), allowObservation: available.allowObservation,
        judge: available.judge, maxEvents: config.maxEvents,
      }, active)
      if (progress.status !== 'end') throw new Error(`互动尚未结束：${progress.status}`)
      const trace = await interaction.trace()
      const actions = trace.flatMap(item => item.actions?.outcomes ?? [])
      const simulation: Simulation = {
        kind: 'simulation', summary: `场景已结算：${scene.situation}`,
        changes: actions.flatMap(action => action.status === 'succeeded' && action.observable ? [action.observable] : []),
        unresolved: actions.filter(action => action.status === 'unresolved').map(action => action.reason),
        evidence: `${sceneId} 的互动记录，共 ${trace.length} 项`,
      }
      await input.recordSceneResult(sceneId, { status: 'completed', simulation })
      await openStoryEvents(roots, { worldId: binding.world.worldId, runId }).adopt(target)
      return simulation
    } finally { await runtime.close() }
  }
  return config.schedule ? config.schedule.handle.execute(await config.schedule.slot(identity), target, (_, active) => simulate(active), signal) : simulate(signal)
}
