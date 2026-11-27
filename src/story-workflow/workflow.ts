import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { StoryProgress } from './types.js'
import { restoreStoryProgress } from './progress.js'
import { simulateStory, type StorySimulationInput } from './simulation.js'
import type { Agent } from '@fly-novel/agents'
import { collaborationIdentity, collaborationSchema, directorDecisionSchema, parseStrictJson, reportSchema, simulationSchema, storyAdvanceSchema, storyCompletionSchema, storyDecisionSchema, storyProgressVersion, taskSchema, type Collaboration, type Simulation, type StoryTask, type SiblingDecision, type StoryNode, type StoryStep } from './types.js'
import { CollaborationStore } from './store.js'
import { evaluateWorldObjectives, storyWorldEvidenceSchema, worldObjectivesSchema, type EventEvidence, type StoryWorldEvidence, type StoryWorldProgressSource, type WorldObjective } from './world-progress.js'

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
      output = (await agent.run({ prompt: `根据以下任务、已知事实和发展方向，规划本轮事件初步安排。计划不是已经发生的事实。只返回严格 JSON：有安排时为 {"kind":"planned","events":["事件描述"]}；没有可推进事件时为 {"kind":"no_events","reason":"原因"}。输入：${JSON.stringify(data)}${'world' in data ? '\n世界资料按 category 使用：setting 为设定，direction 为未来方向，current 为可信当前状态，event 为可信已发生事件。留白、未覆盖和暂留候选保持原有状态。' : ''}` })).content
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
    try { controller.signal.throwIfAborted(); return (await agent.run({ prompt: prompt + directorWorldContext(plan) })).content }
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

export interface StoryTreeOptions extends StoryCollaborationOptions {
  /** 本次最多完成多少个直接演绎的子故事，默认 5。 */
  limit?: number
  /** 由可信应用绑定的本轮事件与世界状态来源。 */
  worldProgress?: StoryWorldProgressSource
  /** 调用方为根故事提供可按事件或状态核查的目标。 */
  worldObjectives?: readonly WorldObjective[]
  /** 模拟器须等待提前汇报的决定。终止时结束演绎并返回已发生的模拟经过。 */
  simulate(input: StorySimulationInput, signal: AbortSignal): Promise<Simulation>
}
type StoryTreeResult =
  | (Extract<StoryStep, { kind: 'result' }> & { completedCount: number })
  | { kind: 'paused'; runId: string; storyId: string; batch: number; completedCount: number }

/** 读取已结束的整轮结果。暂停、旧入口的协作记录或部分写入无法通过核对。 */
export async function readStoryRoundResult(options: Pick<StoryCollaborationOptions, 'planRoot' | 'collaborationRoot' | 'protectedRoots'>, planId: string) {
  const plans = await PlanStore.open(options.planRoot, [...options.protectedRoots, options.collaborationRoot])
  const store = await CollaborationStore.open(options.collaborationRoot, options.planRoot, options.protectedRoots)
  const plan = await plans.read(planId)
  const rootId = await store.readRootStoryId(planId)
  const root = await store.readStoryNode(planId, rootId)
  if (root.parentStoryId !== null) throw new Error('整轮结果的根故事身份不匹配')
  const decision = await store.readStoryStep(planId, rootId, 'decision')
  if (plan.outcome.kind !== 'planned' || decision.kind !== 'decision' || decision.value.kind !== 'split' ||
    !isDeepStrictEqual(decision.value.children, plan.outcome.events) ||
    root.task.goal !== plan.input.task ||
    root.task.background !== JSON.stringify({ facts: plan.input.facts, directions: plan.input.directions })) throw new Error('整轮结果与原规划不一致')
  const result = await store.readStoryStep(planId, rootId, 'result')
  const assessment = await store.readStoryStep(planId, rootId, 'assessment')
  if (result.kind !== 'result' || assessment.kind !== 'assessment' || !isDeepStrictEqual(result.value, assessment.value.report)) throw new Error('整轮结果与评估不一致')
  return { result, assessment: assessment.value }
}

/** 用户选择继续演化时，核对上一轮结束记录，再用调用方提供的新资料独立规划。 */
export async function createNextStoryPlan(options: StoryPlanningOptions & { collaborationRoot: string }, openDirectors: OpenDirectors, previousPlanId: string, input: PlanInput, signal?: AbortSignal): Promise<PlanRecord> {
  signal?.throwIfAborted()
  await readStoryRoundResult({ planRoot: options.root, collaborationRoot: options.collaborationRoot, protectedRoots: options.protectedRoots }, previousPlanId)
  return createStoryPlan({ ...options, protectedRoots: [...options.protectedRoots, options.collaborationRoot] }, openDirectors, input, signal)
}

/** 逐层推进故事，达到本次数量时保存暂停位置；传入批次继续已有暂停。 */
export async function runStoryTree(options: StoryTreeOptions, openDirectors: OpenDirectors, planId: string, signal?: AbortSignal, resumeBatch?: number): Promise<StoryTreeResult> {
  if (!options.provider.trim() || !options.model.trim()) throw new Error('模型配置不能为空')
  const limit = options.limit === undefined ? 5 : options.limit
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('本次演绎数量必须是正整数')
  signal?.throwIfAborted()
  const plans = await PlanStore.open(options.planRoot, [...options.protectedRoots, options.collaborationRoot])
  const store = await CollaborationStore.open(options.collaborationRoot, options.planRoot, options.protectedRoots)
  const plan = await plans.read(planId)
  if (plan.outcome.kind !== 'planned') throw new Error('规划没有事件')
  const source = options.worldProgress
  if (source && (source.runId !== planId || plan.formatVersion !== 2 || plan.input.world.worldId !== source.worldId)) throw new Error('故事状态来源与本轮世界不匹配')
  const objectives = options.worldObjectives ? worldObjectivesSchema.parse(options.worldObjectives) : undefined
  if (objectives && !source) throw new Error('世界评估目标需要可信的状态来源')
  const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex')
  type Result = Extract<StoryStep, { kind: 'result' }>
  type Assessment = Extract<StoryStep, { kind: 'assessment' }>['value']
  type Frame = StoryProgress['frames'][number]
  let frames: Frame[]
  const batch = resumeBatch === undefined ? 1 : resumeBatch + 1
  if (resumeBatch === undefined) {
    const rootId = randomUUID()
    await store.startSiblings(planId, rootId)
    const root: StoryNode = { formatVersion: 1, runId: planId, storyId: rootId, parentStoryId: null, description: plan.input.task, task: { background: JSON.stringify({ facts: plan.input.facts, directions: plan.input.directions }), goal: plan.input.task, constraints: [] } }
    await store.saveStoryNode(root)
    const children = plan.outcome.events
    frames = [{ node: root, children, index: 0, results: [], decisions: [] }]
    await store.saveStoryStep({ formatVersion: 1, runId: planId, storyId: rootId, kind: 'decision', value: { kind: 'split', children } })
  } else {
    frames = await restoreStoryProgress(store, plan, resumeBatch, signal, source, objectives)
  }
  let completedCount = 0
  const call = async (prompt: string, callSignal = signal): Promise<string> => {
    callSignal?.throwIfAborted()
    const scope = await openDirectors()
    let output: string | undefined
    let failure: unknown
    try {
      callSignal?.throwIfAborted()
      const agent = await scope.create('director')
      const cancel = () => agent.cancel()
      callSignal?.addEventListener('abort', cancel, { once: true })
      try { callSignal?.throwIfAborted(); output = (await agent.run({ prompt: prompt + directorWorldContext(plan) })).content }
      finally { callSignal?.removeEventListener('abort', cancel) }
    } catch (error) { failure = error }
    try { await scope.dispose() } catch (error) {
      if (failure !== undefined) throw new AggregateError([failure, error], '导演运行与清理失败')
      throw error
    }
    if (failure !== undefined) throw failure
    callSignal?.throwIfAborted()
    if (output === undefined || !output.trim()) throw new Error('导演没有返回结果')
    return output
  }
  const currentEvidence = async (events: EventEvidence[]): Promise<StoryWorldEvidence | undefined> => {
    if (!source) return undefined
    const current = await source.current()
    if (current.worldId !== source.worldId) throw new Error('当前状态世界与来源不匹配')
    return storyWorldEvidenceSchema.parse({ current, events })
  }
  const frameEvidence = async (frame: Frame) => {
    const evidence = await currentEvidence(frame.results.flatMap(item => item.formatVersion === 3 ? item.worldEvidence.events : []))
    if (evidence && objectives && frame.node.parentStoryId === null) {
      return { ...evidence, objectives: evaluateWorldObjectives(evidence, objectives) }
    }
    return evidence
  }
  const verifyCurrent = async (evidence?: StoryWorldEvidence) => {
    if (evidence && !isDeepStrictEqual(await source!.current(), evidence.current)) throw new Error('导演采用的当前状态已变化')
  }
  const finish = async (node: StoryNode, report: Result['value'], assessment?: Assessment, sceneIds?: string[], worldEvidence?: StoryWorldEvidence): Promise<Result> => {
    await verifyCurrent(worldEvidence)
    const parent = node.parentStoryId === null ? null : await store.readStoryNode(planId, node.parentStoryId)
    const receipt = parent === null ? '根故事回报已记录' : (await call(`你是直接上级导演，请接收下级故事回报并简述进展，不编造已发生的事实：${JSON.stringify({ parent, node, report, assessment, worldEvidence })}`)).trim()
    await verifyCurrent(worldEvidence)
    const fields = { runId: planId, storyId: node.storyId, kind: 'result' as const, value: report, receipt }
    const value: Result = worldEvidence ? { ...fields, formatVersion: 3, sceneIds: sceneIds ?? [], worldEvidence }
      : sceneIds?.length ? { ...fields, formatVersion: 2, sceneIds } : { ...fields, formatVersion: 1 }
    await store.saveStoryStep(value)
    const saved = await store.readStoryStep(planId, node.storyId, 'result')
    if (saved.kind !== 'result') throw new Error('故事结果类型不匹配')
    return saved
  }
  const closeFrame = async (frame: Frame, input: Assessment, worldEvidence?: StoryWorldEvidence) => {
    await verifyCurrent(worldEvidence)
    const assessment = { ...input, report: withWorldFacts(input.report, worldEvidence) }
    await store.saveStoryStep({ formatVersion: 1, runId: planId, storyId: frame.node.storyId, kind: 'assessment', value: assessment })
    const result = await finish(frame.node, assessment.report, assessment, undefined, worldEvidence)
    frames.pop()
    frames.at(-1)?.results.push({ ...result, assessment })
    return result
  }
  const reportFormat = '{"summary":"结果","changes":["变化"],"unresolved":["未解决"],"evidence":"依据"}'
  while (frames.length) {
    signal?.throwIfAborted()
    if (JSON.stringify(await plans.read(planId)) !== JSON.stringify(plan)) throw new Error(`规划已变化，请核查运行 ${planId}`)
    const frame = frames[frames.length - 1]!
    if (frame.index >= frame.children.length) {
      const worldEvidence = await frameEvidence(frame)
      const supplementRule = frame.supplement
        ? '已经安排过补充故事，禁止再补充。'
        : '仅在目标未达成且补充有意义时，可以返回 {"status":"supplement","reason":"尚未达成的原因","description":"一个补充故事"}。'
      const assessment = storyCompletionSchema.parse(parseStrictJson(await call(`你是本层父导演。依据下级已保存的回报、事件与已核对状态评估当前目标，保留实际经过。只返回严格 JSON，结束时返回 status（achieved、unmet 或 terminated）、reason 和 report（${reportFormat}）。unmet 时须另给 adjustment，说明根据实际结果怎样调整父故事。条件变化无法继续时用 terminated，并记录未解决事项。${supplementRule} 资料：${JSON.stringify({ story: frame.node, results: frame.results, decisions: frame.decisions, supplement: frame.supplement, worldEvidence })}`)))
      await verifyCurrent(worldEvidence)
      const findings = worldEvidence?.objectives
      if (findings && assessment.status !== 'terminated' && (assessment.status === 'achieved') !== findings.every(item => item.evidence.kind !== 'unmet')) {
        throw new Error('父导演的评估或补充与目标证据不一致')
      }
      if (assessment.status === 'supplement') {
        if (frame.supplement) throw new Error(`父故事最多补充一个子故事，请核查故事 ${frame.node.storyId}`)
        const supplement = { id: randomUUID(), description: assessment.description, reason: assessment.reason }
        await store.saveStoryStep({ formatVersion: 1, runId: planId, storyId: frame.node.storyId, kind: 'supplement', value: supplement })
        frame.supplement = supplement
        frame.children = [...frame.children, { id: supplement.id, description: supplement.description }]
        continue
      }
      const result = await closeFrame(frame, assessment, worldEvidence)
      if (!frames.length) return { ...result, completedCount }
      continue
    }
    if (completedCount === limit) {
      signal?.throwIfAborted()
      const formatVersion = storyProgressVersion(frames)
      await store.saveStoryProgress({ formatVersion, runId: planId, batch, planHash, frames, ...(formatVersion === 3 && objectives ? { worldObjectives: objectives } : {}) })
      return { kind: 'paused', runId: planId, storyId: frames[0]!.node.storyId, batch, completedCount }
    }
    const child = frame.children[frame.index++]!
    const worldEvidence = await frameEvidence(frame)
    const context = { parent: frame.node, child, prior: frame.results, decisions: frame.decisions, worldEvidence }
    const choice = storyAdvanceSchema.parse(parseStrictJson(await call(`你是父导演。根据上级故事与此前模拟结果判断当前子故事继续、调整或取消。只返回 JSON：{"decision":"continue 或 adjust 或 cancel","reason":"原因及调整方向"}。若条件变化导致整个父故事需要提前结束，返回 {"status":"terminated","reason":"终止原因","report":${reportFormat}}。${JSON.stringify(context)}`)))
    await verifyCurrent(worldEvidence)
    if ('status' in choice) {
      const result = await closeFrame(frame, choice, worldEvidence)
      if (!frames.length) return { ...result, completedCount }
      continue
    }
    await store.saveStoryChoice({ formatVersion: 1, runId: planId, parentStoryId: frame.node.storyId, childStoryId: child.id, description: child.description, ...choice })
    frame.decisions.push({ description: child.description, ...choice })
    if (choice.decision === 'cancel') continue
    const task = taskSchema.parse(parseStrictJson(await call(`你是父导演，制定当前子故事任务，不指定角色行动。只返回 JSON：{"background":"背景","goal":"目标","constraints":["约束"]}。${JSON.stringify({ ...context, choice })}`)))
    await verifyCurrent(worldEvidence)
    const node: StoryNode = { formatVersion: 1, runId: planId, storyId: child.id, parentStoryId: frame.node.storyId, description: child.description, task }
    await store.saveStoryNode(node)
    const mapDirection = plan.formatVersion === 2 ? ' 如场景需要核查城门和等候点，可在 direct 结果附上 mapNeed（cityId、layerId、purpose），只引用提供的城市与地图层面。' : ''
    const decision = storyDecisionSchema.parse(parseStrictJson(await call(`你是子导演，判断当前故事能否直接进行模拟演绎。需要拆分时返回 JSON：{"kind":"split","children":["子故事描述"]}；适合直接演绎时返回 JSON：{"kind":"direct","preparation":"模拟处境"}。${mapDirection}任务：${JSON.stringify(node)}`)))
    if (decision.kind === 'split') {
      const children = decision.children.map(description => ({ id: randomUUID(), description }))
      await store.saveStoryStep({ formatVersion: 1, runId: planId, storyId: node.storyId, kind: 'decision', value: { kind: 'split', children } })
      frames.push({ node, children, index: 0, results: [], decisions: [] })
      continue
    }
    if ('mapNeed' in decision) {
      if (plan.formatVersion !== 2) throw new Error('独立规划不支持场景地图需求')
      await store.saveStoryStep({ formatVersion: 2, runId: planId, storyId: node.storyId, kind: 'decision', value: decision })
    } else {
      await store.saveStoryStep({ formatVersion: 1, runId: planId, storyId: node.storyId, kind: 'decision', value: decision })
    }
    const { simulation, decisions, termination } = await simulateStory(node, frame.node, decision.preparation, { store, options, call, signal,
      ...('mapNeed' in decision ? { mapNeed: decision.mapNeed } : {}) })
    signal?.throwIfAborted()
    const scenes = await store.readSettledScenes(planId, node.storyId)
    if ('mapNeed' in decision && scenes.length === 0) throw new Error(`地图需求尚未形成可核对的场景：${node.storyId}`)
    const sceneIds = scenes.map(scene => scene.sceneId)
    const childEvidence = source ? await currentEvidence(await Promise.all(scenes.filter(scene => scene.formatVersion === 2).map(scene => source.event(node.storyId, scene.sceneId)))) : undefined
    signal?.throwIfAborted()
    await store.saveStoryStep({ formatVersion: 1, runId: planId, storyId: node.storyId, kind: 'simulation', value: simulation })
    const report = withWorldFacts(reportSchema.parse(parseStrictJson(await call(`你是子导演，根据任务和已发生的经过形成最终回报，并考虑提前汇报后的决定。只有已核对状态代表实际写入。只返回 JSON：${reportFormat}。${JSON.stringify({ node, simulation, decisions, ...(scenes.length ? { scenes } : {}), worldEvidence: childEvidence })}`))), childEvidence)
    if (termination) {
      const assessment: Assessment = { status: 'terminated', reason: termination.reason, report }
      await store.saveStoryStep({ formatVersion: 1, runId: planId, storyId: node.storyId, kind: 'assessment', value: assessment })
      frame.results.push({ ...await finish(node, report, assessment, sceneIds, childEvidence), assessment })
    } else {
      frame.results.push(await finish(node, report, undefined, sceneIds, childEvidence))
      completedCount++
    }
  }
  throw new Error('故事运行未产生结果')
}

function withWorldFacts(report: ReturnType<typeof reportSchema.parse>, evidence?: StoryWorldEvidence) {
  if (!evidence) return report
  const { current, events } = evidence
  const changes = current.status === 'waiting' && events.some(item => item.eventId === current.eventId)
    ? [`商队状态已更新为在 ${current.locationId} 等候（版本 ${current.revision}）`] : []
  const unmet = evidence.objectives?.filter(item => item.evidence.kind === 'unmet').map(item => item.objective.description) ?? []
  const unresolved = [...new Set([...report.unresolved, ...unmet, ...events.flatMap(item => item.outcomes.filter(action => action.status === 'unresolved').map(action => action.reason))])]
  return { ...report, changes, unresolved }
}

function directorWorldContext(plan: PlanRecord): string {
  return plan.formatVersion === 2
    ? `\n本轮规划保存的世界资料（按 category 区分设定、方向、当前局势和已发生事件；留白、未覆盖和暂留候选保持原有状态）：${JSON.stringify(plan.input.world)}`
    : ''
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
