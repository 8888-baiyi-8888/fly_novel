import { openStory } from '../story-workflow/story-query.js'
import { sceneInteractionConditionsSchema, sceneInteractionDecisionInputSchema, sceneInteractionDigest, visibleCharacterResponse, type SceneInteractionConditions } from '../story-workflow/scene-interaction.js'
import { parseStrictJson } from '../story-workflow/types.js'

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
    /** 只向子导演提供已记录的感知条件及发言。 */
    async decide(sequence: number, conditionsVersion: string, choose: (prompt: string) => Promise<string>, signal?: AbortSignal) {
      signal?.throwIfAborted()
      const { store } = await open()
      const event = await store.readInteractionEvent(runId, storyId, sceneId, sequence)
      if (event.conditions.version !== conditionsVersion) throw new Error('互动感知条件版本已变化')
      const previous = await store.readInteractionDecision(event)
      if (previous) return previous
      const { characterId, speech, conditions, responseKind } = event
      const prompt = `你是当前子导演。逐角色判断收到或未收到的发言，并选一名有依据的回应者，或等待、核查、结束。只返回 JSON {"perceptions":[{"characterId":"角色 ID","status":"received/partial/not-received/uncertain","reason":"依据","observations":[{"kind":"speech","index":0,"range":[0,2]}]}],"next":{"kind":"respond","characterId":"角色 ID","trigger":{"kind":"observation","index":0}}}。index 从 0 开始，range 为 UTF-16 左闭右开，完整原话省略 range，未收到或待确认 observations 为空。独立触发须引用可信条件中的 initiative.id，格式为 {"kind":"initiative","id":"已有 ID"}。无回应者用 next.kind 为 wait、review 或 end，并提供 reason。发言是角色说法，不据此确认世界事实。资料：${JSON.stringify({ characterId, speech, conditions, responseKind })}`
      const input = sceneInteractionDecisionInputSchema.parse(parseStrictJson(await choose(prompt)))
      signal?.throwIfAborted()
      await store.saveInteractionDecision(runId, storyId, sceneId, { formatVersion: 1, sequence, eventDigest: sceneInteractionDigest(event), ...input })
      return (await store.readInteractionDecision(event))!
    },
    async trace() {
      const { store } = await open()
      const events = await store.listInteractionEvents(runId, storyId, sceneId)
      return Promise.all(events.map(async event => ({ event, decision: await store.readInteractionDecision(event) })))
    },
  })
}

export type StorySceneInteraction = ReturnType<typeof openStorySceneInteraction>
