import { openStory } from '../story-workflow/story-query.js'
import type { SceneInteractionIdentity } from './story-scene-interaction.js'
import { currentScheduledScene } from './story-schedule-context.js'

type Roots = Parameters<typeof openStory>[0]

/** 绑定可信调用方选定的世界和故事运行。记录事件须显式采用已结算场景。 */
export function openStoryEvents(roots: Roots, scope: { worldId: string; runId: string }) {
  const { worldId, runId } = scope
  async function readSource(identity: SceneInteractionIdentity) {
    if (identity.runId !== runId) throw new Error('事件超出授权的故事运行')
    const story = await openStory(roots, runId, identity.storyId)
    if (story.plan.formatVersion !== 2 || story.plan.input.world.worldId !== worldId || story.decision?.kind !== 'direct') {
      throw new Error('事件不属于授权世界的直接演绎故事')
    }
    const scene = await story.store.readSceneSetup(runId, identity.storyId, identity.sceneId)
    if (scene.formatVersion === 2 && (scene.mapEvidence.worldId !== worldId || scene.mapEvidence.deliveryId !== story.plan.input.world.deliveryId ||
      scene.mapEvidence.deliveryVersion !== story.plan.input.world.deliveryVersion)) throw new Error('场景事件的世界证据不匹配')
    return story.store
  }
  return Object.freeze({ worldId, runId,
    async adopt(identity: SceneInteractionIdentity) {
      const permit = currentScheduledScene()
      permit?.assertScene(identity.sceneId, identity.runId, identity.storyId)
      const store = await readSource(identity)
      permit?.assertScene(identity.sceneId, identity.runId, identity.storyId)
      return store.recordSceneEvent(worldId, runId, identity.storyId, identity.sceneId)
    },
    async read(identity: SceneInteractionIdentity) {
      return (await readSource(identity)).readSceneEvent(worldId, runId, identity.storyId, identity.sceneId)
    },
  })
}
