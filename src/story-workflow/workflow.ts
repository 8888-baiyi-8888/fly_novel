import { randomUUID } from 'node:crypto'
import type { Agent } from '@fly-novel/agents'
import { collaborationIdentity, collaborationSchema, directorDecisionSchema, parseStrictJson, reportSchema, simulationSchema, taskSchema, type Collaboration, type Simulation, type StoryTask, type SiblingDecision } from './types.js'
import { CollaborationStore } from './store.js'

export interface DirectorScope { create(role: string): Promise<Agent>; dispose(): Promise<void> }
export type OpenDirectors = () => Promise<DirectorScope>

import type { LlmAdapter } from '@fly-novel/llm'
import { createPlanRecord, planInputSchema, type PlanInput, type PlanRecord } from './types.js'
import { PlanStore } from './store.js'

/** 可信应用提供模型和隔离目录，protectedRoots 必须包含全部需要隔离的业务根。 */
export interface StoryPlanningOptions {
  root: string
  protectedRoots: readonly string[]
  provider: string
  model: string
  adapter: LlmAdapter
}

/** 调用导演生成并保存初步计划；失败时不将模型回复当作已保存的业务结果。 */
export async function createStoryPlan(options: StoryPlanningOptions, openDirectors: OpenDirectors, input: PlanInput, signal?: AbortSignal): Promise<PlanRecord> {
  const data = planInputSchema.parse(input)
  if (!options.provider.trim() || !options.model.trim()) throw new Error('模型配置不能为空')
  signal?.throwIfAborted()
  const store = await PlanStore.open(options.root, options.protectedRoots)
  const framework = await openDirectors()
  let output: string | undefined
  let failure: unknown
  try {
    signal?.throwIfAborted()
    const agent = await framework.create('director')
    const cancel = () => agent.cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      signal?.throwIfAborted()
      output = (await agent.run({ prompt: `根据以下任务、已知事实和发展方向，规划本轮事件初步安排。计划不是已经发生的事实。只返回严格 JSON：有安排时为 {"kind":"planned","events":["事件描述"]}；没有可推进事件时为 {"kind":"no_events","reason":"原因"}。输入：${JSON.stringify(data)}` })).content
    } finally { signal?.removeEventListener('abort', cancel) }
  } catch (error) { failure = error }
  try { await framework.dispose() } catch (error) {
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

/** 可信调用方指定隔离目录与导演模型；模拟器仅提供模拟经过，不写入世界事实。 */
export interface StoryCollaborationOptions {
  planRoot: string
  collaborationRoot: string
  protectedRoots: readonly string[]
  provider: string
  model: string
  adapter: LlmAdapter
  simulate(input: { task: StoryTask; preparation: string }, signal: AbortSignal): Promise<Simulation>
}

/**
 * 执行一个子故事的模拟协作；失败保留尝试记录，不能盲目重试。
 * @param options 可信模型、模拟器及隔离目录配置。
 * @param planId 已保存初步规划的身份。
 * @param eventId 所选规划中子故事的身份。
 * @param signal 取消信号；取消等待已启动的模拟器与导演清理。
 * @returns 已保存的模拟协作结果，不表示世界事件发生。
 * @throws 规划、模型、模拟、保存或清理失败时抛错。
 */
export async function runStoryCollaboration(options: StoryCollaborationOptions, openDirectors: OpenDirectors, planId: string, eventId: string, signal?: AbortSignal, siblings?: { parentStoryId: string; prior: Collaboration[]; decision: SiblingDecision }): Promise<Collaboration> {
  if (!options.provider.trim() || !options.model.trim()) throw new Error('模型配置不能为空')
  signal?.throwIfAborted()
  const planStore = await PlanStore.open(options.planRoot, [...options.protectedRoots, options.collaborationRoot])
  const store = await CollaborationStore.open(options.collaborationRoot, options.planRoot, options.protectedRoots)
  const plan = await planStore.read(planId)
  const generated = collaborationIdentity(plan, eventId)
  const identity = siblings ? { ...generated, parentStoryId: siblings.parentStoryId } : generated
  if (plan.outcome.kind !== 'planned') throw new Error('规划没有事件')
  const event = plan.outcome.events.find(item => item.id === eventId)
  if (!event) throw new Error('事件不属于所选规划')
  signal?.throwIfAborted()
  await store.claim(planId, eventId, identity.id)
  let framework: DirectorScope
  try { framework = await openDirectors() } catch (error) {
    throw new Error(`协作装配失败，请核查事件 ${eventId}`, { cause: error })
  }
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  const call = async (agent: Agent, prompt: string) => {
    controller.signal.throwIfAborted()
    const abortAgent = () => agent.cancel()
    controller.signal.addEventListener('abort', abortAgent, { once: true })
    try { controller.signal.throwIfAborted(); return (await agent.run({ prompt })).content }
    finally { controller.signal.removeEventListener('abort', abortAgent) }
  }
  let record: Collaboration | undefined
  let failure: unknown
  try {
    controller.signal.throwIfAborted()
    const parent = await framework.create('parent-director')
    const task = taskSchema.parse(parseStrictJson(await call(parent, `你是父导演。根据所选初步事件制定子故事任务，不指定角色行动；只返回严格 JSON：{"background":"背景","goal":"目标","constraints":["约束"]}。资料：${JSON.stringify({ input: plan.input, event, ...(siblings ? { prior: siblings.prior.map(item => ({ report: item.report, parentReceipt: item.parentReceipt })), decision: siblings.decision } : {}) })}`)))
    controller.signal.throwIfAborted()
    const child = await framework.create('child-director')
    const preparation = (await call(child, `你是子导演，接受父导演交付的子故事，组织可供模拟演绎的处境，不声称已经发生。任务：${JSON.stringify(task)}`)).trim()
    if (!preparation) throw new Error('子导演没有提供演绎安排')
    controller.signal.throwIfAborted()
    const simulation = simulationSchema.parse(await options.simulate({ task, preparation }, controller.signal))
    controller.signal.throwIfAborted()
    await store.saveSimulation({ formatVersion: 1, collaborationId: identity.id, planId, childStoryId: eventId, task, preparation, simulation })
    controller.signal.throwIfAborted()
    const report = reportSchema.parse(parseStrictJson(await call(child, `以下是模拟演绎经过，不是真实世界事实。请以子导演身份根据经过形成回报，只返回严格 JSON：{"summary":"结果","changes":["变化"],"unresolved":["未解决"],"evidence":"依据"}。模拟经过：${JSON.stringify(simulation)}`)))
    const parentReceipt = (await call(parent, `以下是子导演基于模拟经过形成的回报，不是真实世界事实。请确认已接收并简要说明实际进展及未解决事项，不规划下一个故事：${JSON.stringify(report)}`)).trim()
    if (!parentReceipt) throw new Error('父导演没有返回接收结果')
    controller.signal.throwIfAborted()
    record = collaborationSchema.parse({ formatVersion: 1, ...identity, plan, task, preparation, simulation, report, parentReceipt })
  } catch (error) { failure = error }
  signal?.removeEventListener('abort', cancel)
  try { await framework.dispose() } catch (error) {
    if (failure !== undefined) throw new AggregateError([failure, error], `协作和清理失败，请核查事件 ${eventId}`)
    throw error
  }
  if (failure !== undefined) throw new Error(`子故事协作未完成，请核查事件 ${eventId}`, { cause: failure })
  controller.signal.throwIfAborted()
  if (!record) throw new Error('协作结果缺失')
  if (JSON.stringify(await planStore.read(planId)) !== JSON.stringify(plan)) throw new Error(`规划已变化，请核查事件 ${eventId}`)
  controller.signal.throwIfAborted()
  await store.save(record)
  return record
}

/** 顺序处理同一计划的兄弟故事，失败时停止并保留已经写入的记录。 */
export async function runStorySiblings(options: StoryCollaborationOptions, openDirectors: OpenDirectors, planId: string, signal?: AbortSignal): Promise<{ decisions: SiblingDecision[]; results: Collaboration[] }> {
  if (!options.provider.trim() || !options.model.trim()) throw new Error('模型配置不能为空')
  signal?.throwIfAborted()
  const plans = await PlanStore.open(options.planRoot, [...options.protectedRoots, options.collaborationRoot])
  const store = await CollaborationStore.open(options.collaborationRoot, options.planRoot, options.protectedRoots)
  const plan = await plans.read(planId)
  if (plan.outcome.kind !== 'planned') throw new Error('规划没有事件')
  const parentStoryId = randomUUID()
  await store.startSiblings(planId, parentStoryId)
  const decisions: SiblingDecision[] = []
  const results: Collaboration[] = []
  for (const event of plan.outcome.events) {
    signal?.throwIfAborted()
    if (JSON.stringify(await plans.read(planId)) !== JSON.stringify(plan)) throw new Error(`规划已变化，请核查事件 ${event.id}`)
    const scope = await openDirectors()
    let answer: string | undefined
    let failure: unknown
    try {
      signal?.throwIfAborted()
      const director = await scope.create('parent-director')
      const cancel = () => director.cancel()
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        signal?.throwIfAborted()
        answer = (await director.run({ prompt: `你是父导演。根据初步事件和已完成的模拟结果，判断此事件继续、调整或取消。不得改写已发生的模拟经过。只返回严格 JSON：{"decision":"continue 或 adjust 或 cancel","reason":"原因及调整方向"}。资料：${JSON.stringify({ input: plan.input, event, prior: results.map(item => ({ report: item.report, parentReceipt: item.parentReceipt })), decisions })}` })).content
      } finally { signal?.removeEventListener('abort', cancel) }
    } catch (error) { failure = error }
    try { await scope.dispose() } catch (error) {
      if (failure !== undefined) throw new AggregateError([failure, error], `导演判断和清理失败，请核查事件 ${event.id}`)
      throw error
    }
    if (failure !== undefined) throw failure
    signal?.throwIfAborted()
    if (answer === undefined) throw new Error('导演没有返回事件决定')
    const choice = directorDecisionSchema.parse(parseStrictJson(answer))
    if (JSON.stringify(await plans.read(planId)) !== JSON.stringify(plan)) throw new Error(`规划已变化，请核查事件 ${event.id}`)
    signal?.throwIfAborted()
    const decision: SiblingDecision = { formatVersion: 1, planId, parentStoryId, childStoryId: event.id, ...choice }
    await store.saveSiblingDecision(decision)
    decisions.push(decision)
    if (decision.decision === 'cancel') continue
    const result = await runStoryCollaboration(options, openDirectors, planId, event.id, signal, { parentStoryId, prior: results, decision })
    results.push(await store.read(planId, result.childStoryId))
  }
  return { decisions, results }
}

/** 读取某个兄弟故事的已保存决定。 */
export async function readStorySiblingDecision(options: Pick<StoryCollaborationOptions, 'planRoot' | 'collaborationRoot' | 'protectedRoots'>, planId: string, eventId: string): Promise<SiblingDecision> {
  return (await CollaborationStore.open(options.collaborationRoot, options.planRoot, options.protectedRoots)).readSiblingDecision(planId, eventId)
}

/**
 * 读取已保存的单个协作结果；调用方提供原可信目录。
 * @param options 规划、协作及其他受保护目录。
 * @param planId 原规划身份。
 * @param eventId 所选子故事身份。
 * @returns 经身份和模拟经过核对的协作结果。
 */
export async function readStoryCollaboration(options: Pick<StoryCollaborationOptions, 'planRoot' | 'collaborationRoot' | 'protectedRoots'>, planId: string, eventId: string): Promise<Collaboration> {
  return (await CollaborationStore.open(options.collaborationRoot, options.planRoot, options.protectedRoots)).read(planId, eventId)
}

/**
 * 读取已保存的模拟经过，不证明子导演回报或父导演接收已经完成。
 * @param options 规划、协作及其他受保护目录。
 * @param planId 原规划身份。
 * @param eventId 所选子故事身份。
 * @returns 经身份核对的模拟经过。
 */
export async function readStorySimulation(options: Pick<StoryCollaborationOptions, 'planRoot' | 'collaborationRoot' | 'protectedRoots'>, planId: string, eventId: string) {
  return (await CollaborationStore.open(options.collaborationRoot, options.planRoot, options.protectedRoots)).readSimulation(planId, eventId)
}
