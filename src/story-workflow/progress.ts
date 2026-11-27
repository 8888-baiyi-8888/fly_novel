import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { readSceneViews } from './scenes.js'
import { CollaborationStore, PlanStore } from './store.js'
import { readArrangement, readChildChoice, readIfPresent, readOutcome, readStoryRoot } from './story-query.js'
import type { PlanRecord, StoryNode, StoryProgress, StoryStep } from './types.js'
import type { StoryCollaborationOptions } from './workflow.js'
import type { StoryWorldProgressSource, WorldObjective } from './world-progress.js'

type StoryLocation = Pick<StoryNode, 'storyId' | 'parentStoryId' | 'description'>
type ReviewPoint = {
  current: StoryLocation
  next?: StoryLocation
  scenes?: Awaited<ReturnType<typeof readSceneViews>>
  reason: string
}
type ConfirmedResult = {
  result: Extract<StoryStep, { kind: 'result' }>
  counted: boolean
}

function location(node: StoryNode): StoryLocation {
  const { storyId, parentStoryId, description } = node
  return { storyId, parentStoryId, description }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function inspectTree(store: CollaborationStore, root: StoryNode) {
  const confirmed: ConfirmedResult[] = []
  const visited = new Set<string>()
  async function visit(node: StoryNode): Promise<ReviewPoint | undefined> {
    const current = location(node)
    const { runId, storyId } = node
    let scenes: ReviewPoint['scenes']
    try {
      if (visited.has(storyId)) throw new Error('故事在推进树中重复出现')
      visited.add(storyId)
      const { decision, children } = await readArrangement(store, node)
      if (!decision) return { current, reason: '故事尚无已保存的演绎或拆分决定' }
      const assessment = await readIfPresent(store.readStoryStep(runId, storyId, 'assessment'))
      const terminated = assessment?.kind === 'assessment' && assessment.value.status === 'terminated'
      if (decision.kind === 'direct') {
        scenes = await readSceneViews(store, runId, storyId)
        const unsettled = scenes.find(scene => scene.status === 'pending' || scene.status === 'unresolved')
        if (unsettled) return { current, scenes, reason: `场景尚未结算：${unsettled.sceneId}` }
      }
      const result = await readOutcome(store, node, decision)
      for (const child of children) {
        const next = { storyId: child.id, parentStoryId: storyId, description: child.description }
        const choice = await readChildChoice(store, node, child)
        const childNode = await readIfPresent(store.readStoryNode(runId, child.id))
        if (!choice || choice.decision === 'cancel') {
          if (childNode) return { current: next, reason: '子故事已有节点但缺少有效推进决定' }
          if (!choice && await store.hasStoryRecords(runId, child.id)) {
            return { current: next, reason: '子故事已有推进文件但缺少有效推进决定' }
          }
          if (choice || terminated) continue
          if (result) return { current: next, reason: '父故事已有回报，但此子项缺少推进证据' }
          return { current, next, reason: '下一子项尚无推进决定' }
        }
        if (!childNode || !isDeepStrictEqual(location(childNode), next)) {
          return { current: next, reason: '子故事缺少节点或节点与上级安排不匹配' }
        }
        const pending = await visit(childNode)
        if (pending) return pending
      }
      if (!result) return { current, scenes, reason: '故事回报或其结算证据尚未保存' }
      if (decision.kind === 'direct' && scenes?.length && result.formatVersion === 1) {
        return { current, scenes, reason: '已有场景记录，但故事回报缺少场景引用' }
      }
      confirmed.push({ result, counted: decision.kind === 'direct' && !terminated })
    } catch (error) {
      return { current, scenes, reason: describe(error) }
    }
  }
  const point = await visit(root)
  return { point, confirmed }
}

async function verifyStoryProgress(store: CollaborationStore, progress: StoryProgress): Promise<void> {
  const { runId, frames } = progress
  for (const [depth, frame] of frames.entries()) {
    const { node, index, decisions, results, supplement } = frame
    const parent = frames[depth - 1]
    if (node.runId !== runId || node.parentStoryId !== (parent?.node.storyId ?? null) ||
      (parent && parent.children[parent.index - 1]?.id !== node.storyId) ||
      !isDeepStrictEqual(await store.readStoryNode(runId, node.storyId), node)) throw new Error('暂停记录的父子关系不匹配')
    const split = await store.readStoryStep(runId, node.storyId, 'decision')
    if (split.kind !== 'decision' || split.value.kind !== 'split') throw new Error('暂停记录的拆分安排无效')
    if (supplement) {
      const saved = await store.readStoryStep(runId, node.storyId, 'supplement')
      if (saved.kind !== 'supplement' || !isDeepStrictEqual(saved.value, supplement)) throw new Error('暂停记录的补充安排不匹配')
    }
    const children = supplement ? [...split.value.children, { id: supplement.id, description: supplement.description }] : split.value.children
    if (!isDeepStrictEqual(frame.children.map(({ id, description }) => ({ id, description })), children) || index > children.length || index !== decisions.length) throw new Error('暂停记录的推进位置不匹配')
    const expectedResults: string[] = []
    for (const [position, decision] of decisions.entries()) {
      const child = children[position]!
      const saved = await store.readStoryChoice(runId, child.id)
      if (saved.parentStoryId !== node.storyId || saved.description !== child.description || !isDeepStrictEqual(decision, { description: saved.description, decision: saved.decision, reason: saved.reason })) throw new Error('暂停记录的子故事决定不匹配')
      if (decision.decision !== 'cancel' && child.id !== frames[depth + 1]?.node.storyId) expectedResults.push(child.id)
    }
    if (!isDeepStrictEqual(results.map(result => result.storyId), expectedResults)) throw new Error('暂停记录的子故事结果不完整')
    for (const child of children.slice(index)) {
      if (await store.hasStoryRecords(runId, child.id)) {
        throw new Error(`暂停位置之后已有推进记录：${child.id}`)
      }
    }
    for (const { assessment, ...result } of results) {
      if (!isDeepStrictEqual(await store.readStoryStep(runId, result.storyId, 'result'), result)) throw new Error('暂停记录的子故事结果不匹配')
      const child = await store.readStoryNode(runId, result.storyId)
      const decision = await store.readStoryStep(runId, result.storyId, 'decision')
      if (child.parentStoryId !== node.storyId || decision.kind !== 'decision') throw new Error('暂停记录的已完成子故事关系不匹配')
      if (decision.value.kind === 'split' || assessment?.status === 'terminated') {
        const saved = await store.readStoryStep(runId, result.storyId, 'assessment')
        if (saved.kind !== 'assessment' || !isDeepStrictEqual(saved.value, assessment)) throw new Error('暂停记录的子故事评估不匹配')
      }
      if (decision.value.kind === 'direct' && assessment && assessment.status !== 'terminated') throw new Error('暂停记录包含无效的子故事评估')
      if (decision.value.kind === 'direct') await store.readStoryStep(runId, result.storyId, 'simulation')
    }
  }
}

async function readVerifiedPause(store: CollaborationStore, plan: PlanRecord, batch: number) {
  const progress = await store.readStoryProgress(plan.id, batch)
  if (progress.planHash !== createHash('sha256').update(JSON.stringify(plan)).digest('hex')) {
    throw new Error(`规划已变化，请核查运行 ${plan.id}`)
  }
  await verifyStoryProgress(store, progress)
  return progress
}

function verifyNext(progress: StoryProgress, point: ReviewPoint | undefined): asserts point is ReviewPoint & { next: StoryLocation } {
  const top = progress.frames.at(-1)!
  const next = top.children[top.index]
  if (!next || point?.current.storyId !== top.node.storyId || point.next?.storyId !== next.id) {
    throw new Error(point?.reason ?? '暂停位置与已保存的故事进度不匹配')
  }
}

/** 只读核查最新业务证据。只有 paused 表示尚未消费且可继续的位置。 */
export async function inspectStoryProgress(
  options: Pick<StoryCollaborationOptions, 'planRoot' | 'collaborationRoot' | 'protectedRoots'>,
  planId: string,
) {
  const { planRoot, collaborationRoot, protectedRoots } = options
  const plans = await PlanStore.open(planRoot, [...protectedRoots, collaborationRoot])
  const store = await CollaborationStore.open(collaborationRoot, planRoot, protectedRoots)
  const plan = await plans.read(planId)
  let batch: number | undefined
  let rootId: string | undefined
  let confirmed: ConfirmedResult[] = []
  let point: ReviewPoint | undefined
  try {
    batch = await store.latestStoryBatch(planId)
    rootId = await readIfPresent(store.readRootStoryId(planId))
    if (!rootId && batch === undefined && !await store.hasStoryRecords(planId)) return { status: 'not-started' as const, planId }
    const { root } = await readStoryRoot(store, plan)
    const inspection = await inspectTree(store, root)
    confirmed = inspection.confirmed
    point = inspection.point
    const evidence = { planId, rootStoryId: rootId, batch, confirmed, completedCount: confirmed.filter(item => item.counted).length }
    if (!point) return { ...evidence, status: 'completed' as const }
    if (batch !== undefined) {
      if (await store.hasContinuedStoryProgress(planId, batch)) {
        return { ...evidence, status: 'needs-review' as const, ...point, reason: `第 ${batch} 批暂停已消费。 ${point.reason}` }
      }
      const pause = await readVerifiedPause(store, plan, batch)
      verifyNext(pause, point)
      return { ...evidence, status: 'paused' as const, current: point.current, next: point.next }
    }
    return { ...evidence, status: 'needs-review' as const, ...point }
  } catch (error) {
    return {
      status: 'needs-review' as const, planId, rootStoryId: rootId, batch, confirmed,
      completedCount: confirmed.filter(item => item.counted).length, current: point?.current,
      scenes: point?.scenes, reason: describe(error),
    }
  }
}

/** 核对原规划和已保存的推进记录，独占取得本次继续的位置。 */
export async function restoreStoryProgress(store: CollaborationStore, plan: PlanRecord, resumeBatch: number, signal?: AbortSignal, worldProgress?: StoryWorldProgressSource, objectives?: WorldObjective[]): Promise<StoryProgress['frames']> {
  if (await store.hasContinuedStoryProgress(plan.id, resumeBatch)) throw new Error(`故事暂停位置已使用，请核查批次 ${resumeBatch}`)
  let progress: StoryProgress
  try {
    progress = await readVerifiedPause(store, plan, resumeBatch)
    const { root } = await readStoryRoot(store, plan)
    const { point } = await inspectTree(store, root)
    verifyNext(progress, point)
  } catch (error) {
    if (await store.hasContinuedStoryProgress(plan.id, resumeBatch)) {
      throw new Error(`故事暂停位置已使用，请核查批次 ${resumeBatch}`, { cause: error })
    }
    throw error
  }
  if (progress.formatVersion === 3) {
    if (!worldProgress) throw new Error('继续此批故事需要原世界状态来源')
    const current = await worldProgress.current()
    if (progress.frames.some(frame => frame.results.some(item => {
      if (item.formatVersion !== 3) return false
      const previous = item.worldEvidence.current
      return previous.worldId !== current.worldId || previous.convoyId !== current.convoyId || previous.revision > current.revision ||
        (previous.revision === current.revision && previous.digest !== current.digest)
    }))) {
      throw new Error('继续故事的商队状态身份不匹配')
    }
    if (!isDeepStrictEqual(progress.worldObjectives, objectives)) throw new Error('继续故事的评估目标已变化')
  }
  signal?.throwIfAborted()
  await store.claimStoryProgress(plan.id, resumeBatch)
  return progress.frames
}
