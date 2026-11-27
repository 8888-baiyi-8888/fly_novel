import { randomUUID } from 'node:crypto'
import { relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { MapStoreError, parseMapPlace, type MapStore } from '@fly-novel/map'
import { mapSceneNeedSchema, type MapSceneCheck, type MapSceneNeed } from '../story-workflow/map-scene.js'
import { openStory } from '../story-workflow/story-query.js'
import type { StoryWorldContext } from '../story-workflow/types.js'
import type { bindStoryWorld } from './story-world-materials.js'

type SceneRoots = Parameters<typeof openStory>[0]
type Binding = Awaited<ReturnType<typeof bindStoryWorld>>

/** 应用选择地图句柄及允许读取的地点身份。传入的存储由调用方持有。 */
export interface StoryMapScope {
  binding: Binding
  store: MapStore
  ownerAgentId: string
  cityId: string
  layerId: string
  gateId?: string
  waitingId?: string
}

/** 检查直接演绎故事所需的城门和等候点，保存可按故事重读的核查记录。 */
export async function inspectStoryMapScene(roots: SceneRoots, runId: string, storyId: string, scope: StoryMapScope, input: MapSceneNeed, signal?: AbortSignal) {
  const need = mapSceneNeedSchema.parse(input)
  signal?.throwIfAborted()
  const story = await openStory(roots, runId, storyId)
  if (story.decision?.kind !== 'direct' || story.plan.formatVersion !== 2 || !('mapNeed' in story.decision) || !isDeepStrictEqual(need, story.decision.mapNeed)) {
    throw new Error('地图核查须匹配已绑定世界的直接演绎需求')
  }
  const world = story.plan.input.world
  const result = await checkMapScope(scope, world, need, signal)
  const check: MapSceneCheck = { formatVersion: 1, id: randomUUID(), runId, storyId, worldId: world.worldId, need, result }
  signal?.throwIfAborted()
  await story.store.saveMapSceneCheck(check)
  return check
}

export async function readStoryMapCheck(roots: SceneRoots, runId: string, storyId: string, id: string) {
  const story = await openStory(roots, runId, storyId)
  const check = await story.store.readMapSceneCheck(runId, storyId, id)
  if (story.plan.formatVersion !== 2 || story.plan.input.world.worldId !== check.worldId) throw new Error('地图核查世界不匹配')
  return check
}

export async function checkMapScope(scope: StoryMapScope, world: StoryWorldContext,
  need: MapSceneNeed, signal?: AbortSignal): Promise<MapSceneCheck['result']> {
  const config = scope.binding.world
  const owner = config.agents.find(item => item.agentId === scope.ownerAgentId)
  if (config.worldId !== world.worldId || scope.binding.deliveryId !== world.deliveryId || !owner || scope.store.boundWorldId !== world.worldId ||
      scope.store.rootDirectory !== owner.writableRoot || scope.cityId !== need.cityId || scope.layerId !== need.layerId) {
    return { status: 'forbidden', reason: '地图需求超出绑定世界或地点范围' }
  }
  const prefix = relative(config.readRoot, owner.writableRoot).split(sep).join('/')
  const path = `${prefix}/places/${need.cityId}.json`
  const evidence = world.materials.find(item => item.source.kind === 'catalog' && item.source.ownerAgentId === scope.ownerAgentId && item.source.path === path)
  if (!evidence) return { status: 'uncovered', reason: '本轮规划未读取该地点的当前正文' }
  try {
    const snapshot = await scope.store.snapshot(signal)
    const city = snapshot.places.find(item => item.document.id === need.cityId)
    if (!city || !isDeepStrictEqual(city.document, parseMapPlace(evidence.content))) return { status: 'stale', reason: '当前城市正文与规划来源不同' }
    if (!city.document.parents.some(item => item.layerId === need.layerId)) return { status: 'uncovered', reason: '所选城市在该地图层面没有空间覆盖' }
    const children = snapshot.places.filter(({ document }) => document.parents.some(item => item.layerId === need.layerId && item.parent.kind === 'place' && item.parent.id === need.cityId))
    const gate = children.find(item => item.document.id === scope.gateId)
    const waiting = children.find(item => item.document.id === scope.waitingId)
    if (children.some(item => item !== gate && item !== waiting) && (!gate || !waiting)) {
      return { status: 'uncovered', reason: '存在尚未核查的城内外子地点' }
    }
    const proof = (item: typeof city) => ({ id: item.document.id, version: item.version })
    const available = { city: proof(city), snapshotVersion: snapshot.version }
    if (gate && waiting && gate !== waiting) return { status: 'ready', ...available, gate: proof(gate), waiting: proof(waiting) }
    const missing: ('gate' | 'waiting')[] = []
    if (!gate) missing.push('gate')
    if (!waiting || waiting === gate) missing.push('waiting')
    return { status: 'missing', ...available, ...(gate ? { gate: proof(gate) } : {}), missing }
  } catch (error) {
    signal?.throwIfAborted()
    const status = error instanceof MapStoreError && error.code === 'MAP_FORBIDDEN' ? 'forbidden' : 'failed'
    return { status, reason: error instanceof Error ? error.message : '地图读取失败' }
  }
}
