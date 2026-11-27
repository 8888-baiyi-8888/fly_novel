import { randomUUID } from 'node:crypto'
import { relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { MapStoreError, parseMapPlace, type MapStore } from '@fly-novel/map'
import { mapProposalAnswerSchema, mapRecordDigest, mapSceneNeedSchema, type MapProposalRecord, type MapSceneCheck, type MapSceneNeed, type SceneMapEvidence } from '../story-workflow/map-scene.js'
import { openStory } from '../story-workflow/story-query.js'
import { parseStrictJson, sceneSetupInputSchema, type SceneSetupInput, type StoryWorldContext } from '../story-workflow/types.js'
import { parseDiscussionTarget } from '../world-init/discussion/service.js'
import { CatalogService } from '../world-init/workspace/catalog/service.js'
import type { bindStoryWorld } from './story-world-materials.js'
import { bootstrapAgents } from '@fly-novel/agents'
import type { LlmAdapter } from '@fly-novel/llm'

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

/** 通过无地图或文件工具的临时 Agent 处理一次已核实的地图缺口。 */
export async function requestStoryMapProposal(roots: SceneRoots, runId: string, storyId: string, checkId: string, scope: StoryMapScope,
  model: { provider: string; model: string; adapter: LlmAdapter; timeoutMs: number }, signal?: AbortSignal): Promise<MapProposalRecord> {
  if (!model.provider.trim() || !model.model.trim() || !Number.isSafeInteger(model.timeoutMs) || model.timeoutMs < 1 || model.timeoutMs > 2_147_483_647) {
    throw new Error('地图提案模型配置无效')
  }
  signal?.throwIfAborted()
  const story = await openStory(roots, runId, storyId)
  const check = await story.store.readMapSceneCheck(runId, storyId, checkId)
  if (story.plan.formatVersion !== 2 || check.worldId !== story.plan.input.world.worldId || check.result.status !== 'missing' || !check.result.missing.includes('waiting')) {
    throw new Error('地图提案需要本轮已核实的等候点缺口')
  }
  const current = await checkMapScope(scope, story.plan.input.world, check.need, signal)
  if (!isDeepStrictEqual(current, check.result)) throw new Error('地图核查依据已变化')
  const city = await scope.store.readPlace(check.result.city.id, signal)
  const gate = check.result.gate ? await scope.store.readPlace(check.result.gate.id, signal) : undefined
  if (city.version !== check.result.city.version || gate?.version !== check.result.gate?.version) throw new Error('地图正文版本已变化')
  signal?.throwIfAborted()
  await story.store.claimMapProposal(runId, storyId, checkId)
  const timeout = AbortSignal.timeout(model.timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let result: MapProposalRecord['result'] = { status: 'failed' }
  let framework: Awaited<ReturnType<typeof bootstrapAgents>> | undefined
  try {
    framework = await bootstrapAgents()
    const base = framework.presets.get('map-agent')
    const presetId = 'story-map-proposal'
    framework.presets.register({ ...base, id: presetId, plugins: base.plugins.filter(plugin => plugin.pluginId !== 'map-agent-system-prompt') })
    requestSignal.throwIfAborted()
    const agent = await framework.manager.create({ id: `map-proposal-${checkId}`, presetId, pluginConfigs: {
      'agent-loop-runtime': { provider: model.provider, model: model.model, maxSteps: 1 },
      llm: { adapters: [{ providers: [model.provider], adapter: model.adapter }] },
    } })
    const cancel = () => agent.cancel()
    requestSignal.addEventListener('abort', cancel, { once: true })
    let response: string
    try {
      requestSignal.throwIfAborted()
      response = (await agent.run({ prompt: `你是负责场景空间的地图 Agent。根据获准地图正文提出城门外临时等候点。保持夜间闭门规则和未覆盖范围。只返回 JSON。可拒绝 {"status":"rejected","reason":"原因"}，可提议 {"status":"proposed","cityId":"城市 ID","layerId":"层面","gate":{"kind":"existing","id":"已有城门 ID"},"waiting":{"name":"地名","description":"地形和适用条件","relativeToGate":"相对城门位置"}}。仅在缺少城门时 gate 可为 {"kind":"proposed","description":"拟定城门位置"}。资料：${JSON.stringify({ need: check.need, city: city.document, gate: gate?.document })}` })).content
    } finally { requestSignal.removeEventListener('abort', cancel) }
    requestSignal.throwIfAborted()
    try {
      if (Buffer.byteLength(response, 'utf8') > 16 * 1024) throw new Error('提案超过大小限制')
      result = mapProposalAnswerSchema.parse(parseStrictJson(response))
      if (result.status === 'proposed' && (result.cityId !== check.need.cityId || result.layerId !== check.need.layerId ||
        (gate ? result.gate.kind !== 'existing' || result.gate.id !== gate.document.id : result.gate.kind !== 'proposed'))) result = { status: 'invalid' }
    } catch { result = { status: 'invalid' } }
  } catch {
    result = { status: signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'failed' }
  } finally {
    await framework?.manager.disposeAll()
  }
  const record: MapProposalRecord = { formatVersion: 1, runId, storyId, checkId, result }
  await story.store.saveMapProposal(record)
  return record
}

export async function readStoryMapProposal(roots: SceneRoots, runId: string, storyId: string, checkId: string) {
  const story = await openStory(roots, runId, storyId)
  await story.store.readMapSceneCheck(runId, storyId, checkId)
  return story.store.readMapProposal(runId, storyId, checkId)
}

/** 使用已满足的地图资料，或由可信调用方明确审阅的提案，保存一个场景设置。 */
export async function createStorySceneWithMap(roots: SceneRoots, runId: string, storyId: string, checkId: string, scope: StoryMapScope,
  input: SceneSetupInput, review?: (data: {
    check: MapSceneCheck
    proposal: Extract<MapProposalRecord['result'], { status: 'proposed' }>
    materials: StoryWorldContext['materials']
  }) => Promise<{ status: 'accepted'; actor: string; reason: string } | { status: 'rejected'; reason: string }>, signal?: AbortSignal) {
  const setup = sceneSetupInputSchema.parse(input)
  signal?.throwIfAborted()
  const story = await openStory(roots, runId, storyId)
  if (story.plan.formatVersion !== 2 || story.decision?.kind !== 'direct' || !('mapNeed' in story.decision)) throw new Error('故事缺少已登记的地图需求')
  const world = story.plan.input.world
  const check = await story.store.readMapSceneCheck(runId, storyId, checkId)
  if (check.worldId !== world.worldId || !isDeepStrictEqual(check.need, story.decision.mapNeed)) throw new Error('场景地图需求身份不匹配')
  if (check.result.status !== 'ready' && check.result.status !== 'missing') throw new Error('地图核查尚不可用于场景')
  const verifySources = async () => {
    const current = await checkMapScope(scope, world, check.need, signal)
    if (!isDeepStrictEqual(current, check.result)) throw new Error('场景地图来源版本已变化')
    const config = scope.binding.world
    const path = `${relative(config.readRoot, scope.store.rootDirectory).split(sep).join('/')}/places/${check.need.cityId}.json`
    const catalogMaterial = world.materials.find(item => item.source.kind === 'catalog' && item.source.path === path)
    if (!catalogMaterial || catalogMaterial.source.kind !== 'catalog') throw new Error('场景缺少地图目录来源')
    const catalog = await CatalogService.open(config, { singleWriterProcess: true })
    try {
      const reader = catalog.bind(config.mainAgent.agentId)
      try {
        const live = await reader.readSharedSource(path, catalogMaterial.source.revision, signal)
        if (live.fileStatus !== 'current' || live.contentSha256 !== catalogMaterial.digest) throw new Error('场景地图目录来源已变化')
      } finally { await reader.close() }
    } finally { await catalog.close() }
    const delivered = world.materials.flatMap(item => item.source.kind === 'delivery' ? [{ item, target: parseDiscussionTarget(item.source.target) }] : [])
    const snapshot = await scope.binding.readDelivery(delivered.map(({ target }) => target))
    if (snapshot.version !== world.deliveryVersion || snapshot.reviewVersion !== world.reviewVersion ||
      delivered.some(({ item }, index) => snapshot.artifacts[index]?.version !== item.version || snapshot.artifacts[index]?.digest !== item.digest)) {
      throw new Error('场景交付来源版本已变化')
    }
  }
  await verifySources()
  const evidence: SceneMapEvidence = { checkId, checkDigest: mapRecordDigest(check), worldId: world.worldId,
    deliveryId: world.deliveryId, deliveryVersion: world.deliveryVersion }
  if (check.result.status === 'missing') {
    if (!review) throw new Error('等候点提案尚未取得可信审阅')
    const record = await story.store.readMapProposal(runId, storyId, checkId)
    if (record.result.status !== 'proposed') throw new Error('地图补充未形成可用提案')
    const proposal = record.result
    if (proposal.cityId !== check.need.cityId || proposal.layerId !== check.need.layerId ||
      (check.result.gate ? proposal.gate.kind !== 'existing' || proposal.gate.id !== check.result.gate.id : proposal.gate.kind !== 'proposed')) {
      throw new Error('提案所用城门或地点与核查不匹配')
    }
    const choice = await review(structuredClone({ check, proposal, materials: world.materials }))
    if (choice.status !== 'accepted') throw new Error(`地图提案未采纳：${choice.reason}`)
    evidence.adoption = { actor: choice.actor, reason: choice.reason, proposalDigest: mapRecordDigest(record) }
    await verifySources()
  }
  signal?.throwIfAborted()
  const record = await story.store.saveSceneSetup({ ...setup, runId, storyId, mapEvidence: evidence })
  return { ...record, status: 'pending' as const }
}
