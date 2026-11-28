import { AsyncLocalStorage } from 'node:async_hooks'
import type { CharacterKnowledgeGrant } from '../story-workflow/character-participation.js'
import type { ConvoyProposal } from '../story-workflow/convoy-state.js'
import type { SceneSetupRecord } from '../story-workflow/types.js'
import type { CurrentConvoyEvidence } from '../story-workflow/world-progress.js'
import type { ScheduleSlot } from '../story-workflow/world-schedule.js'

export type ScheduledSceneIdentity = Pick<SceneSetupRecord, 'storyId' | 'sceneId'>
export interface ScheduledExperience {
  readonly source: ScheduledSceneIdentity & { readonly runId: string; readonly worldId: string; readonly minute: number }
  readonly characterId: string
  readonly kind: 'observation' | 'action'
  readonly content: string
  readonly version: string
}
export interface ScheduledScenePermit {
  readonly slot: Readonly<ScheduleSlot>
  readonly identity: Readonly<ScheduledSceneIdentity>
  readonly state?: Readonly<CurrentConvoyEvidence>
  assertActive(): void
  assertScene(sceneId: string, runId: string, storyId: string): void
  assertCharacter(characterId: string, sceneId: string, runId: string, storyId: string): void
  assertConvoyWrite(stateRoot: string, proposal: ConvoyProposal): void
  readConvoy(stateRoot: string, worldId: string, runId: string, convoyId: string): Readonly<CurrentConvoyEvidence>
  experiences(characterId: string): Promise<CharacterKnowledgeGrant[]>
}

export const scheduledExperiencePrefix = 'schedule-experience:'
export const sceneExecutionScope = new AsyncLocalStorage<Readonly<{ owner: object; permit: ScheduledScenePermit }>>()
export function currentScheduledScene() { return sceneExecutionScope.getStore()?.permit }
