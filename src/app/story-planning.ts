import { randomUUID } from 'node:crypto'
import { bootstrapAgents } from '@fly-novel/agents'
import type { LlmAdapter } from '@fly-novel/llm'
import { createPlanRecord, planInputSchema, type PlanInput, type PlanRecord } from '../story-workflow/plan.js'
import { PlanStore } from '../story-workflow/store.js'

/** 可信应用提供模型和隔离目录，protectedRoots 必须包含全部需要隔离的业务根。 */
export interface StoryPlanningOptions {
  root: string
  protectedRoots: readonly string[]
  provider: string
  model: string
  adapter: LlmAdapter
}

/** 调用导演生成并保存初步计划；失败时不将模型回复当作已保存的业务结果。 */
export async function createStoryPlan(options: StoryPlanningOptions, input: PlanInput, signal?: AbortSignal): Promise<PlanRecord> {
  const data = planInputSchema.parse(input)
  if (!options.provider.trim() || !options.model.trim()) throw new Error('模型配置不能为空')
  signal?.throwIfAborted()
  const store = await PlanStore.open(options.root, options.protectedRoots)
  const framework = await bootstrapAgents()
  let output: string | undefined
  let failure: unknown
  try {
    signal?.throwIfAborted()
    const agent = await framework.manager.create({ id: `director-${randomUUID()}`, presetId: 'director-agent', pluginConfigs: {
      'agent-loop-runtime': { provider: options.provider, model: options.model },
      llm: { adapters: [{ providers: [options.provider], adapter: options.adapter }] },
    } })
    const cancel = () => agent.cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      signal?.throwIfAborted()
      output = (await agent.run({ prompt: `根据以下任务、已知事实和发展方向，规划本轮事件初步安排。计划不是已经发生的事实。只返回严格 JSON：有安排时为 {"kind":"planned","events":["事件描述"]}；没有可推进事件时为 {"kind":"no_events","reason":"原因"}。输入：${JSON.stringify(data)}` })).content
    } finally { signal?.removeEventListener('abort', cancel) }
  } catch (error) { failure = error }
  try { await framework.manager.disposeAll() } catch (error) {
    if (failure !== undefined) throw new AggregateError([failure, error], '导演规划和清理失败')
    throw error
  }
  if (failure !== undefined) throw failure
  signal?.throwIfAborted()
  if (output === undefined) throw new Error('导演没有返回规划')
  const record = createPlanRecord(data, output)
  signal?.throwIfAborted()
  await store.save(record)
  return record
}

/** 从可信目录读取并校验已保存的规划；调用方负责提供全部受保护目录。 */
export async function readStoryPlan(options: Pick<StoryPlanningOptions, 'root' | 'protectedRoots'>, id: string): Promise<PlanRecord> {
  return (await PlanStore.open(options.root, options.protectedRoots)).read(id)
}
