import { randomUUID } from 'node:crypto'
import { openStory } from '../story-workflow/story-query.js'
import { interactionObservationSource, sceneInteractionConditionsSchema, sceneInteractionDecisionInputSchema, sceneInteractionDigest, visibleCharacterResponse, type InteractionObservationId, type SceneInteractionConditions, type SceneInteractionDispatch } from '../story-workflow/scene-interaction.js'
import type { CharacterKnowledgeGrant } from '../story-workflow/character-participation.js'
import { parseStrictJson } from '../story-workflow/types.js'
import type { StoryCharacterScope } from './story-character-participation.js'
import type { openStoryCharacterRuntime } from './story-character-runtime.js'

type Roots = Parameters<typeof openStory>[0]
export interface SceneInteractionIdentity { runId: string; storyId: string; sceneId: string }
type CharacterRuntime = Awaited<ReturnType<typeof openStoryCharacterRuntime>>

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

  async function trace() {
    const { store } = await open()
    const events = await store.listInteractionEvents(runId, storyId, sceneId)
    return Promise.all(events.map(async event => {
      const decision = await store.readInteractionDecision(event)
      const dispatch = await store.readInteractionDispatch(event)
      return { event, decision, ...(dispatch ? { dispatch } : {}) }
    }))
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
    trace,
    async findParticipation(participationId: string) {
      return (await trace()).filter(item => item.event.participationId === participationId || item.dispatch?.record.participationId === participationId)
    },
    /** 只执行已保存决定选中的角色。调用方重新批准该角色的观察。 */
    async dispatch(sequence: number, scope: StoryCharacterScope, runtime: CharacterRuntime, grants: readonly CharacterKnowledgeGrant[],
      allowObservation: (subject: { characterId: string; reference: InteractionObservationId; content: string }) => boolean, signal?: AbortSignal) {
      signal?.throwIfAborted()
      const { store, worldId } = await open()
      if (scope.worldId !== worldId || scope.runId !== runId || scope.storyId !== storyId || !runtime.isBoundTo(scope)) throw new Error('角色运行器与当前场景互动不匹配')
      const event = await store.readInteractionEvent(runId, storyId, sceneId, sequence)
      const existing = await store.readInteractionDispatch(event)
      if (existing) return existing
      const decision = await store.readInteractionDecision(event)
      if (decision?.next.kind !== 'respond') throw new Error('场景没有可执行的角色调度')
      const { characterId, trigger } = decision.next
      const participationId = randomUUID()
      const request = await scope.issueScheduled(sceneId, characterId, participationId, event.setupDigest)
      const observations: InteractionObservationId[] = []
      const input = [...grants]
      for (const item of (await trace()).filter(item => item.event.sequence <= sequence && item.event.characterId !== characterId)) {
        const received = item.decision?.perceptions.find(entry => entry.characterId === characterId)
        for (const [index, observation] of (received?.observations ?? []).entries()) {
          const reference = { sequence: item.event.sequence, index }
          if (!allowObservation({ characterId, reference, content: observation.content })) continue
          observations.push(reference)
          input.push({ characterId, sceneId, category: 'observation', content: `听见发言：${observation.content}`, basis: received!.basis,
            source: { kind: 'fixed', id: interactionObservationSource(sceneId, reference), version: item.decision!.eventDigest } })
        }
      }
      if (trigger.kind === 'initiative') {
        const initiative = event.conditions.participants.find(item => item.characterId === characterId)!.initiative!
        input.push({ characterId, sceneId, category: 'goal', content: initiative.description, basis: '场景已核准的独立触发',
          source: { kind: 'fixed', id: initiative.id, version: event.conditions.version } })
      }
      await scope.prepare(request, input)
      const record: SceneInteractionDispatch = { formatVersion: 1, sequence, characterId, participationId, decisionDigest: sceneInteractionDigest(decision), observations }
      signal?.throwIfAborted()
      if (!await store.claimInteractionDispatch(event, record)) return (await store.readInteractionDispatch(event))!
      const participation = await runtime.respond(request, input, signal)
      return { record, participation }
    },
  })
}

export type StorySceneInteraction = ReturnType<typeof openStorySceneInteraction>
