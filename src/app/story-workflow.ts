import { randomUUID } from 'node:crypto'
import { bootstrapAgents } from '@fly-novel/agents'
import type { PlanInput } from '../story-workflow/types.js'
import type { StoryCharacterScope } from './story-character-participation.js'
import type { SceneWorldRuleJudge, StorySceneInteraction } from './story-scene-interaction.js'
import type { SceneInteractionConditions } from '../story-workflow/scene-interaction.js'
import type { StoryTreeOptions } from '../story-workflow/workflow.js'
import { createNextStoryPlan as createNextPlan } from '../story-workflow/workflow.js'
export type { StoryTreeOptions } from '../story-workflow/workflow.js'
import { createStoryPlan as createPlan, runStoryCollaboration as runCollaboration, runStorySiblings as runSiblings, runStoryTree as runTree, type OpenDirectors, type StoryPlanningOptions, type StoryCollaborationOptions } from '../story-workflow/workflow.js'
export type { StoryPlanningOptions, StoryCollaborationOptions } from '../story-workflow/workflow.js'
export { readStoryPlan, readStoryCollaboration, readStorySimulation, readStorySiblingDecision, readStoryRoundResult } from '../story-workflow/workflow.js'
export { readStory } from '../story-workflow/story-query.js'
export { inspectStoryProgress } from '../story-workflow/progress.js'
export { createStoryScene, listStoryScenes, readStoryScene } from '../story-workflow/scenes.js'
export { bindStoryWorld, prepareStoryWorldInput } from './story-world-materials.js'
export { bindStoryCharacters, type StoryCharacterScope, type StoryCharacterCandidate } from './story-character-participation.js'
export type { CharacterKnowledgeGrant } from '../story-workflow/character-participation.js'
export { openStoryCharacterRuntime, type StoryCharacterConfig } from './story-character-runtime.js'
export { openStoryEvents } from './story-event.js'
export { openStorySceneInteraction, type SceneInteractionIdentity, type SceneWorldRuleJudge, type StorySceneInteraction } from './story-scene-interaction.js'
export type { SceneInteractionConditions } from '../story-workflow/scene-interaction.js'
export { createStorySceneWithMap, inspectStoryMapScene, readStoryMapCheck, readStoryMapProposal, readStorySceneWorldEvidence, requestStoryMapProposal, type StoryMapScope } from './story-map-scene.js'
export type { SceneResultInput, SceneSetupInput } from '../story-workflow/types.js'

function directors(options: Pick<StoryPlanningOptions, 'provider' | 'model' | 'adapter'>): OpenDirectors {
  return async () => {
    const framework = await bootstrapAgents()
    return {
      create: role => framework.manager.create({ id: role + '-' + randomUUID(), presetId: 'director-agent', pluginConfigs: {
        'agent-loop-runtime': { provider: options.provider, model: options.model },
        llm: { adapters: [{ providers: [options.provider], adapter: options.adapter }] },
      } }),
      dispose: () => framework.manager.disposeAll(),
    }
  }
}

/** 由当前子导演为一个已保存的场景提出参与请求。 */
export function selectStoryCharacters(scope: StoryCharacterScope, sceneId: string, candidates: readonly string[],
  options: Pick<StoryPlanningOptions, 'provider' | 'model' | 'adapter'>, signal?: AbortSignal) {
  return scope.select(sceneId, candidates, childDirector(options, signal))
}

export function decideStorySceneInteraction(interaction: StorySceneInteraction, sequence: number, conditionsVersion: string,
  options: Pick<StoryPlanningOptions, 'provider' | 'model' | 'adapter'>, signal?: AbortSignal) {
  return interaction.decide(sequence, conditionsVersion, childDirector(options, signal), signal)
}

export function judgeStorySceneActions(interaction: StorySceneInteraction, sequence: number,
  options: Pick<StoryPlanningOptions, 'provider' | 'model' | 'adapter'>, judge?: SceneWorldRuleJudge, signal?: AbortSignal) {
  return interaction.judgeActions(sequence, childDirector(options, signal), judge, signal)
}

/** 从首个角色响应或已保存的互动位置推进。遇到终态或未知结果时交回调用方。 */
export async function runStorySceneInteraction(interaction: StorySceneInteraction, options: {
  initialParticipationId: string
  director: Pick<StoryPlanningOptions, 'provider' | 'model' | 'adapter'>
  scope: StoryCharacterScope
  runtime: Parameters<StorySceneInteraction['dispatch']>[2]
  conditions(sequence: number, participationId: string): Promise<SceneInteractionConditions>
  grants(characterId: string): Promise<Parameters<StorySceneInteraction['dispatch']>[3]>
  allowObservation: Parameters<StorySceneInteraction['dispatch']>[4]
  judge?: SceneWorldRuleJudge
  maxEvents: number
}, signal?: AbortSignal) {
  if (!Number.isSafeInteger(options.maxEvents) || options.maxEvents < 1 || options.maxEvents > 10000) throw new Error('互动推进数量无效')
  signal?.throwIfAborted()
  const trace = await interaction.trace()
  if (trace[0] && trace[0].event.participationId !== options.initialParticipationId) throw new Error('互动起点与已保存事件不匹配')
  const last = trace.at(-1)
  let event = last?.event
  let responseId = options.initialParticipationId
  let sequence = event?.sequence ?? 1
  if (last?.dispatch) {
    const { record, participation } = last.dispatch
    if (participation?.outcome.status !== 'responded') return { status: 'needs-review', sequence, participationId: record.participationId } as const
    responseId = record.participationId
    sequence++
    event = undefined
  }
  for (let handled = 0; handled < options.maxEvents; handled++) {
    signal?.throwIfAborted()
    if (!event) {
      const conditions = await options.conditions(sequence, responseId)
      signal?.throwIfAborted()
      event = await interaction.append(sequence, responseId, conditions)
    }
    if (event.actions.length) await judgeStorySceneActions(interaction, sequence, options.director, options.judge, signal)
    const decision = await decideStorySceneInteraction(interaction, sequence, event.conditions.version, options.director, signal)
    if (decision.next.kind !== 'respond') return { status: decision.next.kind, sequence } as const
    const dispatch = await interaction.dispatch(sequence, options.scope, options.runtime, await options.grants(decision.next.characterId), options.allowObservation, signal)
    if (dispatch.participation?.outcome.status !== 'responded') return { status: 'needs-review', sequence, participationId: dispatch.record.participationId } as const
    responseId = dispatch.record.participationId
    sequence++
    event = undefined
  }
  return { status: 'limit', sequence: sequence - 1 } as const
}

function childDirector(options: Pick<StoryPlanningOptions, 'provider' | 'model' | 'adapter'>, signal?: AbortSignal) {
  return async (prompt: string) => {
    signal?.throwIfAborted()
    const framework = await directors(options)()
    try {
      const director = await framework.create('child-director')
      const cancel = () => director.cancel()
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        signal?.throwIfAborted()
        const output = await director.run({ prompt })
        signal?.throwIfAborted()
        return output.content
      } finally { signal?.removeEventListener('abort', cancel) }
    } finally { await framework.dispose() }
  }
}
export function createStoryPlan(options: StoryPlanningOptions, input: PlanInput, signal?: AbortSignal) {
  return createPlan(options, directors(options), input, signal)
}
export function runStoryCollaboration(options: StoryCollaborationOptions, planId: string, eventId: string, signal?: AbortSignal) {
  return runCollaboration(options, directors(options), planId, eventId, signal)
}

/** 顺序推进规划中的兄弟故事。 */
export function runStorySiblings(options: StoryCollaborationOptions, planId: string, signal?: AbortSignal) {
  return runSiblings(options, directors(options), planId, signal)
}

/** 逐层推进一轮故事，演绎仍由调用方提供模拟器。 */
export function runStoryTree(options: StoryTreeOptions, planId: string, signal?: AbortSignal) {
  return runTree(options, directors(options), planId, signal)
}

/** 从上次返回的暂停批次继续。本次可重新指定演绎数量。 */
export function continueStoryTree(options: StoryTreeOptions, planId: string, batch: number, signal?: AbortSignal) {
  return runTree(options, directors(options), planId, signal, batch)
}

/** 上一轮结束后，用更新的输入开启新一轮规划。 */
export function createNextStoryPlan(options: StoryPlanningOptions & { collaborationRoot: string }, previousPlanId: string, input: PlanInput, signal?: AbortSignal) {
  return createNextPlan(options, directors(options), previousPlanId, input, signal)
}
