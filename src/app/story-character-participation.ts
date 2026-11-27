import { createHash, randomUUID } from 'node:crypto'
import type { CharacterStore } from '@fly-novel/character'
import { characterClaimDigest, characterKnowledgeGrantSchema, characterParticipationClaimSchema, characterSelectionSchema, projectCharacterParticipation, type CharacterKnowledgeEntry, type CharacterKnowledgeGrant, type CharacterParticipationRequest, type CharacterParticipationResult } from '../story-workflow/character-participation.js'
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
  binding: Binding; ownerAgentId: string; store: CharacterStore; candidates: readonly StoryCharacterCandidate[]; privateCharacterIds?: readonly string[]
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
  const privateIds = new Set(options.privateCharacterIds ?? [])
  if ([...privateIds].some(id => !candidates.has(id))) throw new Error('私有记录授权角色不在候选内')
  const issued = new WeakSet<CharacterParticipationRequest>()
  type Preparation = { readonly request: CharacterParticipationRequest; readonly entries: readonly CharacterKnowledgeEntry[] }
  const prepared = new WeakSet<Preparation>()

  async function openBoundScene(sceneId: string) {
    const story = await openStory(recordRoots, runId, storyId)
    if (story.decision?.kind !== 'direct' || story.plan.formatVersion !== 2 || story.plan.input.world.worldId !== world.worldId ||
      story.plan.input.world.deliveryId !== deliveryId) throw new Error('角色参与须归属所选世界的直接演绎故事')
    const scene = await story.store.readSceneSetup(runId, storyId, sceneId)
    if (scene.formatVersion === 2 && (scene.mapEvidence.worldId !== world.worldId || scene.mapEvidence.deliveryId !== deliveryId ||
      scene.mapEvidence.deliveryVersion !== story.plan.input.world.deliveryVersion)) throw new Error('角色参与的场景世界证据不匹配')
    return { ...story, scene }
  }

  async function pendingScene(sceneId: string) {
    const story = await openBoundScene(sceneId)
    if (await story.store.readSceneResult(story.scene) || await readIfPresent(story.store.readStoryStep(runId, storyId, 'simulation'))) throw new Error('角色参与要求待演绎场景')
    return story
  }

  async function readCandidate(characterId: string, allowed: ReadonlySet<string>) {
    const candidate = candidates.get(characterId)
    if (!candidate || !allowed.has(characterId)) throw new Error('角色不在本场景授权候选内')
    const profile = await store.readVersioned(characterId)
    if (profile.document.metadata.id !== characterId || profile.version !== candidate.version) throw new Error('角色身份或档案版本已变化')
    return { ...profile, presence: candidate.presence }
  }

  return Object.freeze({
    worldId: world.worldId, runId, storyId,
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
        const request = Object.freeze({ ...item, participationId: randomUUID(), worldId: world.worldId, runId, storyId, sceneId, profileVersion: version })
        issued.add(request)
        return request
      }))
    },
    /** 调用方在当前场景逐角色授予片段。持久来源的版本及实际文本在调用前复核。 */
    async prepare(request: CharacterParticipationRequest, grants: readonly CharacterKnowledgeGrant[]) {
      if (!issued.has(request)) throw new Error('角色参与请求未由当前子故事签发')
      if (grants.length > 32) throw new Error('角色认知条目超过数量限制')
      const { scene, plan } = await pendingScene(request.sceneId)
      if (plan.formatVersion !== 2) throw new Error('角色认知缺少世界绑定')
      const { document, version } = await readCandidate(request.characterId, new Set([request.characterId]))
      if (version !== request.profileVersion) throw new Error('角色档案版本已变化')
      const entries = grants.map(value => {
        const { source, ...item } = characterKnowledgeGrantSchema.parse(value)
        if (item.characterId !== request.characterId || item.sceneId !== request.sceneId) throw new Error('认知授权角色或场景不匹配')
        let proof: CharacterKnowledgeEntry['source']
        switch (source.kind) {
          case 'profile':
            if (!document.body.includes(item.content)) throw new Error('角色档案不含所选片段')
            proof = { kind: 'profile', id: request.characterId, version }; break
          case 'scene':
            if (!scene[source.field].includes(item.content)) throw new Error('场景未覆盖所选片段')
            proof = { kind: 'scene', id: `${scene.sceneId}:${source.field}`, version: createHash('sha256').update(JSON.stringify(scene)).digest('hex') }; break
          case 'world': {
            const material = plan.input.world.materials[source.index]
            if (!material || material.category === 'direction') throw new Error('角色无权读取该世界资料')
            if (source.version !== material.version) throw new Error('角色认知来源版本已变化')
            if (!material.content.includes(item.content)) throw new Error('世界资料未覆盖所选片段')
            proof = { kind: 'world', id: `${plan.id}:${source.index}`, version: material.version }; break
          }
          case 'fixed': proof = { kind: 'fixed', id: source.id, version: source.version }; break
        }
        return Object.freeze({ ...item, source: Object.freeze(proof) })
      })
      if (!entries.some(item => item.source.kind === 'profile' && item.category === 'profile')) throw new Error('角色认知缺少获准的人物档案')
      if (!entries.some(item => item.category === 'observation')) throw new Error('角色认知缺少当前处境')
      if (Buffer.byteLength(JSON.stringify(entries)) > 64 * 1024) throw new Error('角色认知材料超过大小限制')
      const preparation = Object.freeze({ request, entries: Object.freeze(entries) })
      prepared.add(preparation)
      return preparation
    },
    async record(preparation: Preparation, configVersion: string, execute: () => Promise<Pick<CharacterParticipationResult, 'outcome' | 'history'>>) {
      if (!prepared.has(preparation)) throw new Error('参与输入未由当前子故事核准')
      const { request, entries } = preparation
      const { sceneId, participationId } = request
      const { store: records } = await pendingScene(sceneId)
      const claim = characterParticipationClaimSchema.parse({ formatVersion: 1, request, entries, configVersion })
      if (!await records.claimCharacterParticipation(claim)) {
        const saved = await records.readCharacterParticipation(runId, storyId, sceneId, participationId)
        if (characterClaimDigest(saved.claim) !== characterClaimDigest(claim)) throw new Error('同一参与身份的请求内容已变化')
        return projectCharacterParticipation(saved.claim, saved.result)
      }
      const result = await records.saveCharacterParticipation(claim, await execute())
      return projectCharacterParticipation(claim, result)
    },
    /** 场景视图只返回获准角色的参与状态、可感知响应及身份。 */
    async list(sceneId: string) {
      const { store: records } = await openBoundScene(sceneId)
      const ids = await records.listCharacterParticipationIds(runId, storyId, sceneId)
      const entries = await Promise.all(ids.map(id => records.readCharacterParticipation(runId, storyId, sceneId, id)))
      if (entries.some(item => item.claim.request.worldId !== world.worldId)) throw new Error('角色参与记录世界不匹配')
      return entries.filter(item => candidates.has(item.claim.request.characterId)).map(({ claim, result }) => projectCharacterParticipation(claim, result))
    },
    /** 只有调用方明确授予私有记录读取权限的角色才能读取完整记录。 */
    async readPrivate(sceneId: string, characterId: string, participationId: string) {
      if (!privateIds.has(characterId)) throw new Error('无权读取角色私有参与记录')
      const { store: records } = await openBoundScene(sceneId)
      const entry = await records.readCharacterParticipation(runId, storyId, sceneId, participationId)
      if (entry.claim.request.worldId !== world.worldId || entry.claim.request.characterId !== characterId) throw new Error('参与记录与授权角色不匹配')
      return entry
    },
  })
}

export type StoryCharacterScope = ReturnType<typeof bindStoryCharacters>
