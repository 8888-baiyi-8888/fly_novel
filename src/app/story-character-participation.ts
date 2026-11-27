import { randomUUID } from 'node:crypto'
import type { CharacterStore } from '@fly-novel/character'
import { characterSelectionSchema } from '../story-workflow/character-participation.js'
import { openStory, readIfPresent } from '../story-workflow/story-query.js'
import { parseStrictJson } from '../story-workflow/types.js'
import type { bindStoryWorld } from './story-world-materials.js'

type Roots = Parameters<typeof openStory>[0]
type Binding = Awaited<ReturnType<typeof bindStoryWorld>>
export interface StoryCharacterCandidate {
  readonly characterId: string
  readonly version: string
  readonly presence: string
}

/** 固定当前子故事的角色候选范围，人物存储由调用方所有。 */
export function bindStoryCharacters(roots: Roots, identity: { runId: string; storyId: string }, options: {
  binding: Binding; ownerAgentId: string; store: CharacterStore; candidates: readonly StoryCharacterCandidate[]
}) {
  const { world, deliveryId } = options.binding
  const { runId, storyId } = identity
  const { store } = options
  const owner = world.agents.find(item => item.agentId === options.ownerAgentId)
  if (!owner || store.rootDirectory !== owner.writableRoot) throw new Error('角色存储与世界负责人配置不匹配')
  const protectedRoots = [...new Set([...roots.protectedRoots, world.readRoot])]
  const recordRoots = { ...roots, protectedRoots }
  const candidates = new Map(options.candidates.map(candidate => [candidate.characterId, { ...candidate }]))
  if (candidates.size !== options.candidates.length) throw new Error('场景角色候选重复')

  async function pendingScene(sceneId: string) {
    const story = await openStory(recordRoots, runId, storyId)
    if (story.decision?.kind !== 'direct' || story.plan.formatVersion !== 2 || story.plan.input.world.worldId !== world.worldId ||
      story.plan.input.world.deliveryId !== deliveryId) throw new Error('角色参与须归属所选世界的直接演绎故事')
    const scene = await story.store.readSceneSetup(runId, storyId, sceneId)
    if (scene.formatVersion === 2 && (scene.mapEvidence.worldId !== world.worldId || scene.mapEvidence.deliveryId !== deliveryId ||
      scene.mapEvidence.deliveryVersion !== story.plan.input.world.deliveryVersion)) throw new Error('角色参与的场景世界证据不匹配')
    if (await story.store.readSceneResult(scene) || await readIfPresent(story.store.readStoryStep(runId, storyId, 'simulation'))) throw new Error('角色参与要求待演绎场景')
    return { ...story, scene }
  }

  async function readCandidate(characterId: string, allowed: ReadonlySet<string>) {
    const candidate = candidates.get(characterId)
    if (!candidate || !allowed.has(characterId)) throw new Error('角色不在本场景授权候选内')
    const profile = await store.readVersioned(characterId)
    if (profile.document.metadata.id !== characterId || profile.version !== candidate.version) throw new Error('角色身份或档案版本已变化')
    return { ...profile, presence: candidate.presence }
  }

  return Object.freeze({
    worldId: world.worldId, runId, storyId, pendingScene,
    /** 调用方选择本场景的候选子集。导演只收到最小候选信息。 */
    async select(sceneId: string, characterIds: readonly string[], choose: (prompt: string) => Promise<string>) {
      const { scene } = await pendingScene(sceneId)
      const allowed = new Set(characterIds)
      if (allowed.size !== characterIds.length) throw new Error('场景候选角色重复')
      const roster = await Promise.all(characterIds.map(async characterId => {
        const { document, presence } = await readCandidate(characterId, allowed)
        return { characterId, name: document.metadata.name, presence }
      }))
      const output = characterSelectionSchema.parse(parseStrictJson(await choose(`你是当前场景的子导演，请从候选中选择参与者。邀请描述处境及回应机会，不指定角色行动。只返回 JSON {"participants":[{"characterId":"候选 ID","invitation":"回应契机"}]}，也可以返回空列表。场景：${JSON.stringify({ situation: scene.situation, preparation: scene.preparation, candidates: roster })}`)))
      await pendingScene(sceneId)
      return Promise.all(output.participants.map(async item => {
        const { version } = await readCandidate(item.characterId, allowed)
        return Object.freeze({ ...item, participationId: randomUUID(), worldId: world.worldId, runId, storyId, sceneId, profileVersion: version })
      }))
    },
  })
}

export type StoryCharacterScope = ReturnType<typeof bindStoryCharacters>
