import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { PlanStore, CollaborationStore } from '../story-workflow/store.js'
import { openStoryRunRecords, runDigest, storyRunManifestSchema, storyRunIdSchema, type StoryRunManifest } from '../story-workflow/run-records.js'
import type { StoryPlanningOptions } from '../story-workflow/workflow.js'
import { readIfPresent } from '../story-workflow/story-query.js'
import { prepareStoryWorldInput, type bindStoryWorld } from './story-world-materials.js'
import { createReservedStoryPlan } from './story-workflow.js'

type Binding = Awaited<ReturnType<typeof bindStoryWorld>>
type MaterialSelection = Parameters<typeof prepareStoryWorldInput>[1]
type Roots = { planRoot: string; collaborationRoot: string; protectedRoots: readonly string[] }
const owners = new Set<string>()

export interface StoryRunWorkflowOptions extends Roots {
  runRoot: string
  binding: Binding
  director: Pick<StoryPlanningOptions, 'provider' | 'model' | 'adapter'>
  /** 模型、人物授权及应用策略发生语义变化时更换此版本。 */
  configurationVersion: string
}

/** 使用可信目录和世界绑定打开运行入口。借用的资料服务由调用方关闭。 */
export async function openStoryRunWorkflow(options: StoryRunWorkflowOptions) {
  const { binding, director } = options
  const { world, deliveryId } = binding
  const configurationVersion = z.string().trim().min(1).parse(options.configurationVersion)
  z.string().trim().min(1).parse(director.provider)
  z.string().trim().min(1).parse(director.model)
  storyRunIdSchema.parse(deliveryId)
  const protectedRoots = [...new Set([...options.protectedRoots, world.readRoot])]
  const records = await openStoryRunRecords(options.runRoot, [options.planRoot, options.collaborationRoot, ...protectedRoots])
  const roots = { planRoot: options.planRoot, collaborationRoot: options.collaborationRoot, protectedRoots: [...protectedRoots, records.root] }
  const planning = { ...director, root: roots.planRoot, protectedRoots: [...roots.protectedRoots, roots.collaborationRoot] }
  const plans = await PlanStore.open(planning.root, planning.protectedRoots)
  await CollaborationStore.open(roots.collaborationRoot, roots.planRoot, roots.protectedRoots)
  const configuration = runDigest({ world, deliveryId, configurationVersion, root: records.root, ...roots, provider: director.provider, model: director.model })
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
  return Object.freeze({
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
