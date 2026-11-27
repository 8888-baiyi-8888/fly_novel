import { openStory } from '../story-workflow/story-query.js'
import { sceneInteractionConditionsSchema, sceneInteractionDigest, visibleCharacterResponse, type SceneInteractionConditions } from '../story-workflow/scene-interaction.js'

type Roots = Parameters<typeof openStory>[0]
export interface SceneInteractionIdentity { runId: string; storyId: string; sceneId: string }

/** 场景互动的可信应用入口。业务读取按运行、故事及场景核对。 */
export function openStorySceneInteraction(roots: Roots, identity: SceneInteractionIdentity) {
  const { runId, storyId, sceneId } = identity
  async function open() {
    const story = await openStory(roots, runId, storyId)
    if (story.decision?.kind !== 'direct' || story.plan.formatVersion !== 2) throw new Error('场景互动要求绑定世界的直接演绎故事')
    const setup = await story.store.readSceneSetup(runId, storyId, sceneId)
    if (setup.formatVersion === 2 && (setup.mapEvidence.worldId !== story.plan.input.world.worldId ||
      setup.mapEvidence.deliveryId !== story.plan.input.world.deliveryId || setup.mapEvidence.deliveryVersion !== story.plan.input.world.deliveryVersion)) {
      throw new Error('场景互动的世界证据不匹配')
    }
    return { store: story.store, setup, worldId: story.plan.input.world.worldId }
  }

  return Object.freeze({
    async append(sequence: number, participationId: string, input: SceneInteractionConditions) {
      const conditions = sceneInteractionConditionsSchema.parse(input)
      const { store, setup, worldId } = await open()
      const { claim, result } = await store.readCharacterParticipation(runId, storyId, sceneId, participationId)
      if (claim.request.worldId !== worldId || result?.outcome.status !== 'responded') throw new Error('场景事件缺少可信角色响应')
      const event = { formatVersion: 1 as const, runId, storyId, sceneId, sequence, participationId, characterId: claim.request.characterId,
        conditions, setupDigest: sceneInteractionDigest(setup), ...visibleCharacterResponse(result.outcome.response) }
      await store.saveInteractionEvent(event)
      return event
    },
    async read() {
      const { store } = await open()
      return store.listInteractionEvents(runId, storyId, sceneId)
    },
  })
}
