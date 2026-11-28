import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { readSceneViews } from './scenes.js'
import { CollaborationStore, PlanStore } from './store.js'
import { readArrangement, readChildChoice, readIfPresent, readOutcome, readStoryRoot } from './story-query.js'
import type { PlanRecord, StoryNode, StoryProgress, StoryStep } from './types.js'
import type { StoryCollaborationOptions } from './workflow.js'
import { worldObjectivesSchema, type StoryWorldProgressSource, type WorldObjective } from './world-progress.js'
import { reviewChoiceSchema, reviewEvidenceHash, reviewTime, type StoryReviewChoice, type StoryReviewIdentity, type StoryReviewPolicy } from './user-review.js'

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
type ProgressRoots = Pick<StoryCollaborationOptions, 'planRoot' | 'collaborationRoot' | 'protectedRoots'>
export type StoryReviewOptions = ProgressRoots & {
  now?: () => number
  worldProgress?: StoryWorldProgressSource
  worldObjectives?: readonly WorldObjective[]
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

async function openReview(options: ProgressRoots, runId: string, batch: number) {
  const { planRoot, collaborationRoot, protectedRoots } = options
  const plans = await PlanStore.open(planRoot, [...protectedRoots, collaborationRoot])
  const store = await CollaborationStore.open(collaborationRoot, planRoot, protectedRoots)
  const plan = await plans.read(runId)
  const progress = await store.readStoryProgress(runId, batch)
  const review = progress.review
  if (!review) throw new Error('该批次没有父故事安排审阅')
  return { store, plan, progress, review }
}

/** 只读重开指定批次的审阅快照及决定，保留已消费的历史记录。 */
export async function readStoryReview(options: ProgressRoots, runId: string, batch: number) {
  const { store, review } = await openReview(options, runId, batch)
  return { review, consumed: await store.hasContinuedStoryProgress(runId, batch), decision: await store.readReviewDecision(review) }
}

function verifyReviewIdentity(review: StoryReviewIdentity, expected: StoryReviewIdentity) {
  if (review.reviewId !== expected.reviewId || review.version !== expected.version) throw new Error('所见审阅身份或版本不匹配')
}

async function currentReviewEvidence(plan: PlanRecord, options: StoryReviewOptions) {
  const source = options.worldProgress
  if (source && (source.runId !== plan.id || plan.formatVersion !== 2 || source.worldId !== plan.input.world.worldId)) throw new Error('审阅的世界状态来源与本轮不匹配')
  const objectives = options.worldObjectives && worldObjectivesSchema.parse(options.worldObjectives)
  if (objectives && !source) throw new Error('审阅使用的评估目标需要可信世界状态来源')
  return reviewEvidenceHash(source, objectives)
}

async function verifyPendingReview(store: CollaborationStore, plan: PlanRecord, batch: number) {
  if (await store.latestStoryBatch(plan.id) !== batch || await store.hasContinuedStoryProgress(plan.id, batch)) throw new Error('审阅批次不再等待决定')
  const pause = await readVerifiedPause(store, plan, batch)
  const { root } = await readStoryRoot(store, plan)
  verifyNext(pause, (await inspectTree(store, root)).point)
  return pause
}

async function decideStoryReview(options: StoryReviewOptions, runId: string, batch: number, expected: StoryReviewIdentity, choice?: StoryReviewChoice) {
  const { store, plan, review } = await openReview(options, runId, batch)
  verifyReviewIdentity(review, expected)
  return store.withReviewDecision(review, async () => {
    const matching = (saved: NonNullable<Awaited<ReturnType<typeof store.readReviewDecision>>>) => {
      if (choice === undefined ? saved.source === 'timeout' : saved.source === 'user' && isDeepStrictEqual(saved.choice, choice)) return saved
      throw new Error('此版本已有其他审阅决定')
    }
    const saved = await store.readReviewDecision(review)
    if (saved) return matching(saved)
    await verifyPendingReview(store, plan, batch)
    if (await currentReviewEvidence(plan, options) !== review.evidenceHash) throw new Error('审阅依据已变化，请重新展示并取得决定')
    const identity = { formatVersion: 1 as const, reviewId: review.reviewId, version: review.version, decidedAt: reviewTime(options.now) }
    if (choice !== undefined) {
      return matching(await store.publishReviewDecision(review, { ...identity, source: 'user', choice }))
    }
    if (review.deadline === undefined) throw new Error('持续等待模式没有超时决定')
    if (identity.decidedAt < review.deadline) throw new Error('审阅尚未到期')
    return matching(await store.publishReviewDecision(review, {
      ...identity, source: 'timeout', deadline: review.deadline, choice: { kind: 'select', optionId: review.recommendedId },
    }))
  })
}

/** 从可信用户提交已展示版本的选项或明确取消。 */
export function submitStoryReview(options: StoryReviewOptions, runId: string, batch: number, expected: StoryReviewIdentity, choice: StoryReviewChoice) {
  return decideStoryReview(options, runId, batch, { ...expected }, reviewChoiceSchema.parse(choice))
}

/** 应用定时或重开后显式调用，按可信时钟尝试采用已保存推荐项。 */
export function settleStoryReview(options: StoryReviewOptions, runId: string, batch: number, expected: StoryReviewIdentity) {
  return decideStoryReview(options, runId, batch, { ...expected })
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
      if (pause.review) {
        const review = pause.review
        const decision = await store.readReviewDecision(review)
        if (!decision) return { ...evidence, status: 'awaiting-review' as const, current: point.current, review }
        if (decision.source === 'refresh') return { ...evidence, status: 'needs-review' as const, ...point, reason: '替代审阅尚未保存' }
        const status = decision.choice.kind === 'cancel' ? 'review-cancelled' as const : 'review-ready' as const
        return { ...evidence, status, current: point.current, review, decision }
      }
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
export async function restoreStoryProgress(store: CollaborationStore, plan: PlanRecord, resumeBatch: number, signal?: AbortSignal, worldProgress?: StoryWorldProgressSource, objectives?: WorldObjective[], reviewPolicy?: StoryReviewPolicy): Promise<StoryProgress['frames']> {
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
  if (!isDeepStrictEqual(progress.reviewPolicy, reviewPolicy)) throw new Error('继续故事的审阅模式已变化')
  if (progress.review) throw new Error('父故事安排需要审阅决定')
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
