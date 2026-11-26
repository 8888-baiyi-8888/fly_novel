import { isDeepStrictEqual } from 'node:util'
import type { CollaborationStore } from './store.js'
import type { StoryProgress } from './types.js'

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

/** 核对原规划和已保存的推进记录，独占取得本次继续的位置。 */
export async function restoreStoryProgress(store: CollaborationStore, planId: string, resumeBatch: number, planHash: string, signal?: AbortSignal): Promise<StoryProgress['frames']> {
  const progress = await store.readStoryProgress(planId, resumeBatch)
  if (progress.planHash !== planHash) throw new Error(`规划已变化，请核查运行 ${planId}`)
  await verifyStoryProgress(store, progress)
  signal?.throwIfAborted()
  await store.claimStoryProgress(planId, resumeBatch)
  return progress.frames
}
