import { isDeepStrictEqual } from 'node:util'
import { CollaborationStore, PlanStore } from './store.js'
import type { PlanRecord, StoryNode, StoryStep } from './types.js'
import type { StoryCollaborationOptions } from './workflow.js'

type Arrangement = { id: string; description: string }
type Decision = Extract<StoryStep, { kind: 'decision' }>['value']

export async function readIfPresent<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

export async function readArrangement(store: CollaborationStore, node: StoryNode) {
  const { runId, storyId } = node
  const step = await readIfPresent(store.readStoryStep(runId, storyId, 'decision'))
  const supplement = await readIfPresent(store.readStoryStep(runId, storyId, 'supplement'))
  const decision = step?.kind === 'decision' ? step.value : undefined
  const children: Arrangement[] = decision?.kind === 'split' ? [...decision.children] : []
  if (supplement?.kind === 'supplement') {
    if (decision?.kind !== 'split') throw new Error(`补充安排缺少对应拆分：${storyId}`)
    const { id, description } = supplement.value
    children.push({ id, description })
  }
  if (new Set(children.map(child => child.id)).size !== children.length || children.some(child => child.id === storyId)) {
    throw new Error(`子故事安排身份不匹配：${storyId}`)
  }
  return { decision, children }
}

export async function readOutcome(store: CollaborationStore, node: StoryNode, decision: Decision | undefined) {
  const { runId, storyId } = node
  const result = await readIfPresent(store.readStoryStep(runId, storyId, 'result'))
  if (result?.kind !== 'result' || !decision) return undefined
  const assessment = await readIfPresent(store.readStoryStep(runId, storyId, 'assessment'))
  if (assessment?.kind === 'assessment' && !isDeepStrictEqual(assessment.value.report, result.value)) {
    throw new Error(`故事回报与评估不一致：${storyId}`)
  }
  if (decision.kind === 'split') return assessment ? result : undefined
  if (assessment?.kind === 'assessment' && assessment.value.status !== 'terminated') {
    throw new Error(`直接演绎的故事评估不一致：${storyId}`)
  }
  const simulation = await readIfPresent(store.readStoryStep(runId, storyId, 'simulation'))
  return simulation ? result : undefined
}

export async function readChildChoice(store: CollaborationStore, parent: StoryNode, child: Arrangement) {
  const choice = await readIfPresent(store.readStoryChoice(parent.runId, child.id))
  if (choice && (choice.parentStoryId !== parent.storyId || choice.description !== child.description)) {
    throw new Error(`子故事决定与上级安排不匹配：${child.id}`)
  }
  return choice
}

async function readChildProgress(store: CollaborationStore, parent: StoryNode, child: Arrangement) {
  const choice = await readChildChoice(store, parent, child)
  const node = await readIfPresent(store.readStoryNode(parent.runId, child.id))
  if (!node) {
    if (choice?.decision === 'cancel') return { ...child, status: 'cancelled' as const, choice }
    if (!choice) return { ...child, status: 'planned' as const }
    return { ...child, status: 'incomplete' as const, choice }
  }
  if (!choice || choice.decision === 'cancel' || node.parentStoryId !== parent.storyId || node.description !== child.description) {
    throw new Error(`子故事与上级安排不匹配：${child.id}`)
  }
  const { decision } = await readArrangement(store, node)
  const result = await readOutcome(store, node, decision)
  return result
    ? { ...child, status: 'completed' as const, choice, result }
    : { ...child, status: 'incomplete' as const, choice }
}

/** 核对根故事与保存的规划一致。 */
export async function readStoryRoot(store: CollaborationStore, plan: PlanRecord) {
  const planId = plan.id
  const rootId = await store.readRootStoryId(planId)
  const root = await store.readStoryNode(planId, rootId)
  const rootArrangement = await readArrangement(store, root)
  const rootDecision = rootArrangement.decision
  if (plan.outcome.kind !== 'planned' || root.parentStoryId !== null || rootDecision?.kind !== 'split' ||
    !isDeepStrictEqual(rootDecision.children, plan.outcome.events) || root.task.goal !== plan.input.task ||
    root.task.background !== JSON.stringify({ facts: plan.input.facts, directions: plan.input.directions })) {
    throw new Error(`根故事与原规划不一致：${planId}`)
  }
  return { root, rootArrangement }
}

/** 打开可信记录根并核对目标故事归属。 */
export async function openStory(
  options: Pick<StoryCollaborationOptions, 'planRoot' | 'collaborationRoot' | 'protectedRoots'>,
  planId: string,
  storyId?: string,
) {
  const { planRoot, collaborationRoot, protectedRoots } = options
  const plans = await PlanStore.open(planRoot, [...protectedRoots, collaborationRoot])
  const store = await CollaborationStore.open(collaborationRoot, planRoot, protectedRoots)
  const plan = await plans.read(planId)
  const { root, rootArrangement } = await readStoryRoot(store, plan)
  const rootId = root.storyId
  const node = storyId === undefined || storyId === rootId ? root : await store.readStoryNode(planId, storyId)
  let current = node
  let parent: StoryNode | null = null
  let siblingIndex: number | null = null
  const seen = new Set<string>()
  while (current.storyId !== rootId) {
    if (current.parentStoryId === null || seen.has(current.storyId)) {
      throw new Error(`故事的上级链与根故事不匹配：${current.storyId}`)
    }
    seen.add(current.storyId)
    const upper = current.parentStoryId === rootId ? root : await store.readStoryNode(planId, current.parentStoryId)
    const { children } = upper === root ? rootArrangement : await readArrangement(store, upper)
    const index = children.findIndex(child => child.id === current.storyId)
    const child = children[index]
    if (!child || child.description !== current.description) throw new Error(`故事与上级安排不匹配：${current.storyId}`)
    const choice = await readChildChoice(store, upper, child)
    if (!choice || choice.decision === 'cancel') throw new Error(`故事缺少有效的上级推进决定：${current.storyId}`)
    if (current === node) {
      parent = upper
      siblingIndex = index
    }
    current = upper
  }

  const { decision, children } = node === root ? rootArrangement : await readArrangement(store, node)
  return { store, plan, node, parent, siblingIndex, decision, children }
}

/**
 * 只读查询多层推进的故事任务、直接上级、同层位置及直接子项进展。
 * 省略 storyId 时读取规划的根故事。缺失目标、缺失上级或身份不一致时抛错。
 */
export async function readStory(options: Parameters<typeof openStory>[0], planId: string, storyId?: string) {
  const { store, node, parent, siblingIndex, decision, children } = await openStory(options, planId, storyId)
  return {
    node,
    parent,
    siblingIndex,
    decision,
    result: await readOutcome(store, node, decision),
    children: await Promise.all(children.map(child => readChildProgress(store, node, child))),
  }
}
