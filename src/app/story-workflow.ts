import { randomUUID } from 'node:crypto'
import { bootstrapAgents } from '@fly-novel/agents'
import type { PlanInput } from '../story-workflow/types.js'
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
export type { SceneResultInput, SceneSetupInput } from '../story-workflow/types.js'

function directors(options: StoryPlanningOptions | StoryCollaborationOptions): OpenDirectors {
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
