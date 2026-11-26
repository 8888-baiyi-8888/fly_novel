import { randomUUID } from 'node:crypto'
import { bootstrapAgents } from '@fly-novel/agents'
import type { PlanInput } from '../story-workflow/types.js'
import { createStoryPlan as createPlan, runStoryCollaboration as runCollaboration, type OpenDirectors, type StoryPlanningOptions, type StoryCollaborationOptions } from '../story-workflow/workflow.js'
export type { StoryPlanningOptions, StoryCollaborationOptions } from '../story-workflow/workflow.js'
export { readStoryPlan, readStoryCollaboration, readStorySimulation } from '../story-workflow/workflow.js'

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
