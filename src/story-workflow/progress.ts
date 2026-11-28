import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { readSceneViews } from './scenes.js'
import { CollaborationStore, PlanStore } from './store.js'
import { readArrangement, readChildChoice, readIfPresent, readOutcome, readStoryRoot } from './story-query.js'
import { storyProgressVersion, type PlanRecord, type StoryNode, type StoryProgress, type StoryStep } from './types.js'
import type { StoryCollaborationOptions } from './workflow.js'
import { worldObjectivesSchema, type StoryWorldProgressSource, type WorldObjective } from './world-progress.js'
import { createReviewSnapshot, reviewChoiceSchema, reviewDigest, readReviewEvidence, reviewTime, selectReviewArrangement, verifyRefreshedEvidence, type StoryReviewChoice, type StoryReviewDecision, type StoryReviewIdentity, type StoryReviewPolicy, type StoryReviewConfiguration } from './user-review.js'

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

async function inspectTree(store: CollaborationStore, root: StoryNode, planHash: string) {
  const confirmed: ConfirmedResult[] = []
  const visited = new Set<string>()
  async function visit(node: StoryNode): Promise<ReviewPoint | undefined> {
    const current = location(node)
    const { runId, storyId } = node
    let scenes: ReviewPoint['scenes']
    try {
      if (visited.has(storyId)) throw new Error('故事在推进树中重复出现')
      visited.add(storyId)
      const { decision, children } = await readArrangement(store, node, planHash)
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
    const arrangement = await readArrangement(store, node, progress.planHash)
    if (arrangement.decision?.kind !== 'split') throw new Error('暂停记录的拆分安排无效')
    if (!isDeepStrictEqual(supplement, arrangement.supplement)) throw new Error('暂停记录的补充安排不匹配')
    if (!isDeepStrictEqual(frame.adoptedReview, arrangement.adoptedReview)) throw new Error('暂停记录的审阅依据不匹配')
    const { children } = arrangement
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
  if (progress.planHash !== reviewDigest(plan)) {
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
  const { store, plan, review } = await openReview(options, runId, batch)
  if (review.planHash !== reviewDigest(plan)) throw new Error('审阅的规划已变化')
  const transition = await store.readReviewTransition(review)
  return {
    review, consumed: transition?.kind === 'adopted', decision: await store.readReviewDecision(review),
    ...(transition?.kind === 'refreshed' ? { replacementBatch: transition.replacement.batch } : {}),
  }
}

function verifyReviewIdentity(review: StoryReviewIdentity, expected: StoryReviewIdentity) {
  if (review.reviewId !== expected.reviewId || review.version !== expected.version) throw new Error('所见审阅身份或版本不匹配')
}

async function currentReviewEvidence(plan: PlanRecord, options: StoryReviewOptions) {
  const source = options.worldProgress
  if (source && (source.runId !== plan.id || plan.formatVersion !== 2 || source.worldId !== plan.input.world.worldId)) throw new Error('审阅的世界状态来源与本轮不匹配')
  const objectives = options.worldObjectives && worldObjectivesSchema.parse(options.worldObjectives)
  if (objectives && !source) throw new Error('审阅使用的评估目标需要可信世界状态来源')
  return readReviewEvidence(source, objectives)
}

async function verifyPendingReview(store: CollaborationStore, plan: PlanRecord, batch: number) {
  if (await store.latestStoryBatch(plan.id) !== batch || await store.hasContinuedStoryProgress(plan.id, batch)) throw new Error('审阅批次不再等待决定')
  const pause = await readVerifiedPause(store, plan, batch)
  const { root, planHash } = await readStoryRoot(store, plan)
  verifyNext(pause, (await inspectTree(store, root, planHash)).point)
  return pause
}

async function decideStoryReview(options: StoryReviewOptions, runId: string, batch: number, expected: StoryReviewIdentity, choice?: StoryReviewChoice) {
  const { store, plan, review } = await openReview(options, runId, batch)
  verifyReviewIdentity(review, expected)
  return store.withReviewDecision(review, async () => {
    const matching = (saved: StoryReviewDecision) => {
      if (choice === undefined ? saved.source === 'timeout' : saved.source === 'user' && isDeepStrictEqual(saved.choice, choice)) return saved
      throw new Error('此版本已有其他审阅决定')
    }
    if ((await store.readReviewTransition(review))?.kind === 'refreshed') throw new Error('所见审阅版本已被替代')
    const saved = await store.readReviewDecision(review)
    if (saved) return matching(saved)
    await verifyPendingReview(store, plan, batch)
    if ((await currentReviewEvidence(plan, options)).evidenceHash !== review.evidenceHash) throw new Error('审阅依据已变化，请重新展示并取得决定')
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

/** 依据变化时发布新版安排，保留旧版本及其决定。重复请求可补齐替代批次。 */
export async function refreshStoryReview(options: StoryReviewOptions & Pick<StoryReviewConfiguration, 'propose'>, runId: string, batch: number, expected: StoryReviewIdentity) {
  const { store, plan, review, progress } = await openReview(options, runId, batch)
  verifyReviewIdentity(review, expected)
  return store.withReviewDecision(review, async () => {
    let transition = await store.readReviewTransition(review)
    if (!transition) {
      await verifyPendingReview(store, plan, batch)
      if ((await store.readReviewDecision(review))?.choice.kind === 'cancel') throw new Error('父故事安排审阅已取消')
      const objectives = options.worldObjectives && worldObjectivesSchema.parse(options.worldObjectives)
      if (!isDeepStrictEqual(progress.worldObjectives, objectives)) throw new Error('替代审阅需要原评估目标')
      const evidence = await currentReviewEvidence(plan, options)
      if (evidence.evidenceHash === review.evidenceHash) throw new Error('审阅依据没有变化')
      verifyRefreshedEvidence(review.worldState, evidence.worldState)
      const { runId, parentStoryId, planHash, goal, constraints, children, policy } = review
      const subject = { runId, parentStoryId, planHash, goal, constraints, children, ...evidence, batch: batch + 1 }
      const alternatives = options.propose?.(structuredClone(subject))
      if (!alternatives && (review.options.length !== 1 || review.options[0]?.id !== 'original' || review.dependencies.length !== 0)) {
        throw new Error('重新审阅需要应用重新核定可用选项和依赖')
      }
      const openedAt = reviewTime(options.now)
      if (openedAt < review.openedAt) throw new Error('替代审阅时间早于原审阅')
      const replacement = createReviewSnapshot(subject, randomUUID(), policy, openedAt, alternatives)
      const candidate = { ...progress, batch: replacement.batch, review: replacement }
      store.encodeStoryProgress(candidate)
      const draft = { kind: 'refreshed', formatVersion: 1, reviewId: review.reviewId, version: review.version, replacement } as const
      if (await store.publishReviewTransition(review, draft)) transition = draft
      else transition = await store.readReviewTransition(review)
    }
    if (transition?.kind !== 'refreshed') throw new Error('审阅已取得推进位置')
    const { replacement } = transition
    let saved = await readIfPresent(store.readStoryProgress(runId, replacement.batch))
    if (!saved) {
      const replacementProgress = { ...progress, batch: replacement.batch, review: replacement }
      await store.saveStoryProgress(replacementProgress)
      saved = replacementProgress
    }
    if (!isDeepStrictEqual(saved.review, replacement)) throw new Error('替代审阅批次不匹配')
    return replacement
  })
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
    const { root, planHash } = await readStoryRoot(store, plan)
    const inspection = await inspectTree(store, root, planHash)
    confirmed = inspection.confirmed
    point = inspection.point
    const evidence = { planId, rootStoryId: rootId, batch, confirmed, completedCount: confirmed.filter(item => item.counted).length }
    if (!point) return { ...evidence, status: 'completed' as const }
    if (batch !== undefined) {
      if (await store.hasContinuedStoryProgress(planId, batch)) {
        return { ...evidence, status: 'needs-review' as const, ...point, reason: `第 ${batch} 批暂停已消费。 ${point.reason}` }
      }
      const savedPause = await store.readStoryProgress(planId, batch)
      if (savedPause.review) {
        const transition = await store.readReviewTransition(savedPause.review)
        if (transition) {
          const reason = transition.kind === 'adopted' ? '审阅已取得推进位置' : '替代审阅尚未保存'
          return { ...evidence, status: 'needs-review' as const, ...point, reason: `${reason}。 ${point.reason}` }
        }
      }
      const pause = await readVerifiedPause(store, plan, batch)
      verifyNext(pause, point)
      if (pause.review) {
        const review = pause.review
        const decision = await store.readReviewDecision(review)
        if (!decision) return { ...evidence, status: 'awaiting-review' as const, current: point.current, review }
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
  const checkpoint = await store.readStoryProgress(plan.id, resumeBatch)
  if (!isDeepStrictEqual(checkpoint.reviewPolicy, reviewPolicy)) throw new Error('继续故事的审阅模式已变化')
  if (checkpoint.review) {
    const review = checkpoint.review
    return store.withReviewDecision(review, async () => {
      const transition = await store.readReviewTransition(review)
      if (transition?.kind === 'adopted') throw new Error('审阅已取得推进位置，请核查已有结果')
      if (transition?.kind === 'refreshed') throw new Error('审阅已被替代，请核查最新批次')
      const progress = await verifyPendingReview(store, plan, resumeBatch)
      const decision = await store.readReviewDecision(review)
      if (!decision) throw new Error('父故事安排需要审阅决定')
      const selected = selectReviewArrangement(review, decision)
      await verifyResumeWorld(progress, worldProgress, objectives)
      if ((await readReviewEvidence(worldProgress, objectives)).evidenceHash !== review.evidenceHash) throw new Error('审阅依据已变化，请重新展示并取得决定')
      signal?.throwIfAborted()
      const draft = { kind: 'adopted', formatVersion: 1, ...selected.adoptedReview } as const
      if (!await store.publishReviewTransition(review, draft)) throw new Error('审阅处理位置已被领取，请核查已有记录')
      const top = progress.frames.at(-1)!
      Object.assign(top, selected)
      return progress.frames
    })
  }
  let progress: StoryProgress
  try {
    progress = await readVerifiedPause(store, plan, resumeBatch)
    const { root, planHash } = await readStoryRoot(store, plan)
    const { point } = await inspectTree(store, root, planHash)
    verifyNext(progress, point)
  } catch (error) {
    if (await store.hasContinuedStoryProgress(plan.id, resumeBatch)) {
      throw new Error(`故事暂停位置已使用，请核查批次 ${resumeBatch}`, { cause: error })
    }
    throw error
  }
  await verifyResumeWorld(progress, worldProgress, objectives)
  signal?.throwIfAborted()
  await store.claimStoryProgress(plan.id, resumeBatch)
  return progress.frames
}

async function verifyResumeWorld(progress: StoryProgress, worldProgress?: StoryWorldProgressSource, objectives?: WorldObjective[]) {
  if (storyProgressVersion(progress.frames) === 3 || progress.worldObjectives) {
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
  }
  if (progress.formatVersion >= 3 && !isDeepStrictEqual(progress.worldObjectives, objectives)) throw new Error('继续故事的评估目标已变化')
}
