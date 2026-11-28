import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { PlanStore, CollaborationStore } from '../story-workflow/store.js'
import { openStoryRunRecords, runDigest, storyRunManifestSchema, storyRunIdSchema, type StoryRunManifest } from '../story-workflow/run-records.js'
import type { StoryPlanningOptions, StoryTreeOptions } from '../story-workflow/workflow.js'
import { readIfPresent } from '../story-workflow/story-query.js'
import { prepareStoryWorldInput, type bindStoryWorld } from './story-world-materials.js'
import { continueStoryTree, createReservedStoryPlan, inspectStoryProgress, readStoryRoundResult, runStoryTree, settleStoryReview, submitStoryReview, type StoryReviewChoice, type StoryReviewIdentity } from './story-workflow.js'
import { reviewPolicySchema } from '../story-workflow/user-review.js'
import { runManagedScene, type StoryRunSceneOptions } from './story-run-scene.js'
import { openStoryConvoyState } from './story-convoy-state.js'
export type { StoryRunSceneOptions } from './story-run-scene.js'

type Binding = Awaited<ReturnType<typeof bindStoryWorld>>
type MaterialSelection = Parameters<typeof prepareStoryWorldInput>[1]
type Roots = { planRoot: string; collaborationRoot: string; protectedRoots: readonly string[] }
const owners = new Set<string>()
function evidenceIssue(error: unknown): 'missing' | 'forbidden' | 'stale' | 'corrupt' | 'failed' {
  if (error instanceof SyntaxError || error instanceof z.ZodError) return 'corrupt'
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  if (code === 'ENOENT') return 'missing'
  if (code === 'EACCES' || code === 'EPERM' || (error instanceof Error && /无权|未经授权/.test(error.message))) return 'forbidden'
  if (error instanceof Error && /已变化|版本不同|不匹配/.test(error.message)) return 'stale'
  return 'failed'
}

export interface StoryRunWorkflowOptions extends Roots {
  runRoot: string
  binding: Binding
  director: Pick<StoryPlanningOptions, 'provider' | 'model' | 'adapter'>
  /** 模型、人物授权及应用策略发生语义变化时更换此版本。 */
  configurationVersion: string
  execution?: Pick<StoryTreeOptions, 'limit' | 'review' | 'worldObjectives'> & {
    scene: StoryRunSceneOptions
    worldProgress?(planId: string, signal: AbortSignal): StoryTreeOptions['worldProgress']
  }
}

/** 使用可信目录和世界绑定打开运行入口。借用的资料服务由调用方关闭。 */
export async function openStoryRunWorkflow(options: StoryRunWorkflowOptions) {
  const { binding, director } = options
  const execution = options.execution
  const { world, deliveryId } = binding
  const configurationVersion = z.string().trim().min(1).parse(options.configurationVersion)
  z.string().trim().min(1).parse(director.provider)
  z.string().trim().min(1).parse(director.model)
  storyRunIdSchema.parse(deliveryId)
  const policy = reviewPolicySchema.parse(execution?.review?.policy ?? { kind: 'off' })
  if (execution) {
    z.number().int().min(1).max(10000).parse(execution.scene.maxEvents)
    if (execution.limit !== undefined) z.number().int().positive().parse(execution.limit)
    if (execution.scene.schedule) z.string().trim().min(1).parse(execution.scene.schedule.version)
  }
  const protectedRoots = [...new Set([...options.protectedRoots, world.readRoot])]
  const records = await openStoryRunRecords(options.runRoot, [options.planRoot, options.collaborationRoot, ...protectedRoots])
  const roots = { planRoot: options.planRoot, collaborationRoot: options.collaborationRoot, protectedRoots: [...protectedRoots, records.root] }
  const planning = { ...director, root: roots.planRoot, protectedRoots: [...roots.protectedRoots, roots.collaborationRoot] }
  const plans = await PlanStore.open(planning.root, planning.protectedRoots)
  const collaboration = await CollaborationStore.open(roots.collaborationRoot, roots.planRoot, roots.protectedRoots)
  const configuration = runDigest({ world, deliveryId, configurationVersion, root: records.root, ...roots, provider: director.provider, model: director.model,
    policy, objectives: execution?.worldObjectives, schedule: execution?.scene.schedule?.version,
    convoy: execution?.scene.convoy && { id: execution.scene.convoy.convoyId, root: execution.scene.convoy.stateRoot } })
  if (owners.has(records.root)) throw new Error('故事运行目录已有可信写入者')
  owners.add(records.root)
  const lifecycle = new AbortController()
  const operations = new Map<string, Promise<unknown>>()
  let closing: Promise<void> | undefined

  function operate<T>(runId: string, task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    lifecycle.signal.throwIfAborted()
    storyRunIdSchema.parse(runId)
    const active = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal
    const previous = operations.get(runId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(() => {
      active.throwIfAborted()
      return task(active)
    })
    operations.set(runId, operation)
    const remove = () => { if (operations.get(runId) === operation) operations.delete(runId) }
    void operation.then(remove, remove)
    return operation
  }
  async function manifest(runId: string) {
    const value = await records.read(runId, 'manifest', storyRunManifestSchema)
    if (value && (value.runId !== runId || value.worldId !== world.worldId || value.deliveryId !== deliveryId || value.configuration !== configuration)) {
      throw new Error('故事运行的世界、交付或可信配置已变化')
    }
    return value
  }
  async function readPlan(value: StoryRunManifest) {
    const plan = await readIfPresent(plans.read(value.planId))
    if (plan && !isDeepStrictEqual(plan.input, value.input)) throw new Error('已保存规划与运行意图不匹配')
    return plan
  }
  async function inspect(runId: string) {
    storyRunIdSchema.parse(runId)
    let planId: string | undefined
    try {
      const saved = await manifest(runId)
      if (!saved) return { runId, status: 'missing' as const, issue: 'missing' as const }
      planId = saved.planId
      const plan = await readPlan(saved)
      if (!plan) return { runId, planId, status: 'planning' as const }
      if (plan.outcome.kind === 'no_events') return { runId, planId, status: 'no-events' as const, reason: plan.outcome.reason }
      const progress = await inspectStoryProgress(roots, planId)
      if (progress.status === 'completed') {
        const completed = await readStoryRoundResult(roots, planId)
        return { runId, planId, status: completed.assessment.status === 'terminated' ? 'terminated' as const : 'completed' as const, completed }
      }
      if (progress.status === 'not-started') return { runId, planId, status: 'ready' as const }
      if (progress.status === 'paused' || progress.status === 'awaiting-review' || progress.status === 'review-ready' || progress.status === 'review-cancelled') {
        return { ...progress, runId, planId }
      }
      const scenes = progress.current ? await Promise.all((await collaboration.listSceneSetups(planId, progress.current.storyId)).map(async scene => {
        const [result, events, participants] = await Promise.all([
          collaboration.readSceneResult(scene), collaboration.listInteractionEvents(plan.id, scene.storyId, scene.sceneId),
          collaboration.listCharacterParticipationIds(plan.id, scene.storyId, scene.sceneId),
        ])
        const participation = await Promise.all(participants.map(id => collaboration.readCharacterParticipation(plan.id, scene.storyId, scene.sceneId, id)))
        const tail = events.at(-1)
        const dispatch = tail && await collaboration.readInteractionDispatch(tail)
        return { sceneId: scene.sceneId, order: scene.order, status: result?.status ?? 'pending', sequence: tail?.sequence ?? 0,
          participation: participation.map(item => ({ id: item.claim.request.participationId,
            characterId: item.claim.request.characterId, status: item.result?.outcome.status ?? 'pending' })),
          ...(dispatch ? { dispatchId: dispatch.record.participationId, dispatchStatus: dispatch.participation?.outcome.status ?? 'pending' } : {}),
        }
      })) : []
      return { runId, planId, status: 'needs-review' as const, current: progress.current, batch: progress.batch,
        reason: progress.reason, scenes, confirmed: progress.confirmed.map(item => item.result.storyId) }
    } catch (error) {
      return { runId, planId, status: 'blocked' as const, issue: evidenceIssue(error) }
    }
  }
  async function diagnose(runId: string) {
    const result = await inspect(runId)
    return { ...result, version: runDigest(result) }
  }
  async function executionInputs(runId: string, active: AbortSignal) {
    const saved = await manifest(runId)
    if (!saved || !await readPlan(saved)) throw new Error('故事运行尚无已保存规划')
    if (!execution) throw new Error('故事运行未装配场景执行')
    const convoy = execution.scene.convoy
    const worldProgress = execution.worldProgress?.(saved.planId, active) ?? (convoy ?
      execution.scene.schedule?.handle.progress(saved.planId, active) ??
        (await openStoryConvoyState(roots, { ...convoy, worldId: world.worldId, runId: saved.planId })).progress : undefined)
    const tree: StoryTreeOptions = { ...roots, ...director, limit: execution.limit, review: execution.review, worldObjectives: execution.worldObjectives, worldProgress,
      simulate: (input, signal) => runManagedScene(records, runId, roots, binding, director, execution.scene, input, signal) }
    return { saved, tree, reviewOptions: { ...roots, now: execution.review?.now, worldProgress, worldObjectives: execution.worldObjectives } }
  }
  return Object.freeze({
    diagnose,
    advance(runId: string, version: string, signal?: AbortSignal) {
      return operate(runId, async active => {
        const state = await diagnose(runId)
        if (state.version !== version) throw new Error('运行诊断版本已变化')
        if (state.status !== 'ready' && state.status !== 'paused' && state.status !== 'review-ready') return state
        const { saved, tree } = await executionInputs(runId, active)
        if (state.status === 'ready') await runStoryTree(tree, saved.planId, active)
        else await continueStoryTree(tree, saved.planId, state.batch!, active)
        return diagnose(runId)
      }, signal)
    },
    submitReview(runId: string, batch: number, expected: StoryReviewIdentity, choice: StoryReviewChoice, signal?: AbortSignal) {
      return operate(runId, async active => {
        const { saved, reviewOptions } = await executionInputs(runId, active)
        return submitStoryReview(reviewOptions, saved.planId, batch, expected, choice)
      }, signal)
    },
    settleReview(runId: string, batch: number, expected: StoryReviewIdentity, signal?: AbortSignal) {
      return operate(runId, async active => {
        const { saved, reviewOptions } = await executionInputs(runId, active)
        return settleStoryReview(reviewOptions, saved.planId, batch, expected)
      }, signal)
    },
    async read(runId: string) {
      const saved = await manifest(runId)
      if (!saved) return undefined
      return { manifest: saved, plan: await readPlan(saved) }
    },
    start(runId: string, selection: MaterialSelection, signal?: AbortSignal) {
      const request = structuredClone(selection)
      return operate(runId, async active => {
        const digest = runDigest(request)
        let saved = await manifest(runId)
        if (saved && saved.request !== digest) throw new Error('同一运行身份对应不同开始请求')
        if (!saved) {
          const input = await prepareStoryWorldInput(binding, request)
          active.throwIfAborted()
          saved = await records.save(runId, 'manifest', storyRunManifestSchema, {
            formatVersion: 1, runId, planId: randomUUID(), rootStoryId: randomUUID(), worldId: world.worldId, deliveryId,
            configuration, request: digest, input,
          })
        }
        return await readPlan(saved) ?? await createReservedStoryPlan(planning, saved.planId, saved.input, active)
      }, signal)
    },
    close() {
      return closing ??= (async () => {
        lifecycle.abort(new Error('故事运行服务已关闭'))
        await Promise.allSettled(operations.values())
        owners.delete(records.root)
      })()
    },
  })
}
