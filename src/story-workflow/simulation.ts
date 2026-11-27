import type { CollaborationStore } from './store.js'
import type { MapSceneNeed } from './map-scene.js'
import { parseStrictJson, reportSchema, sceneResultInputSchema, simulationSchema, storyNoticeDecisionSchema, storyNoticeInputSchema, type SceneResultInput, type Simulation, type StoryNode, type StoryNoticeDecision, type StoryNoticeInput, type StoryTask } from './types.js'

export interface StorySimulationInput {
  /** 当前运行及直接演绎故事的业务身份，用于创建对应场景。 */
  readonly runId: string
  readonly storyId: string
  task: StoryTask
  preparation: string
  mapNeed?: MapSceneNeed
  reportEarly(notice: StoryNoticeInput): Promise<StoryNoticeDecision>
  /** 将当前故事的场景模拟结果独占写入。模拟器须等待写入完毕。 */
  recordSceneResult(sceneId: string, input: SceneResultInput): Promise<void>
}

/** 执行一次最小子故事的模拟演绎，结束前等待所有提前汇报调用收尾。 */
export async function simulateStory(node: StoryNode, parent: StoryNode, preparation: string, context: {
  store: CollaborationStore
  options: { simulate(input: StorySimulationInput, signal: AbortSignal): Promise<Simulation> }
  call(prompt: string, signal: AbortSignal): Promise<string>
  signal?: AbortSignal
  mapNeed?: MapSceneNeed
}) {
  const { store, options, call, signal } = context
  const reportFormat = '{"summary":"结果","changes":["变化"],"unresolved":["未解决"],"evidence":"依据"}'
  const lifecycle = new AbortController()
  const simSignal = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal
  const notices = new Map<string, { situation: string; response: Promise<StoryNoticeDecision> }>()
  const sceneWrites = new Set<Promise<void>>()
  let accepting = true
  let waiting = false
  let termination: Extract<StoryNoticeDecision, { action: 'terminate' }> | undefined
  let protocolError: Error | undefined
  const decideNotice = async (input: StoryNoticeInput): Promise<StoryNoticeDecision> => {
    if (!accepting) throw new Error('演绎已经结束，不能提前汇报')
    simSignal.throwIfAborted()
    const parsed = storyNoticeInputSchema.safeParse(input)
    if (!parsed.success) {
      protocolError = new Error('提前汇报输入无效', { cause: parsed.error })
      throw protocolError
    }
    const { id, situation } = parsed.data
    const previous = notices.get(id)
    if (previous?.situation === situation) return previous.response
    if (previous || waiting || termination) {
      protocolError = new Error(previous ? '重复通知的内容不一致' : '当前故事不能接受新的提前汇报')
      throw protocolError
    }
    waiting = true
    const response = (async () => {
      const identity = { formatVersion: 1 as const, runId: node.runId, storyId: node.storyId, parentStoryId: parent.storyId, noticeId: id }
      const report = reportSchema.parse(parseStrictJson(await call(`你是当前子导演。将模拟演绎中影响父故事的重大情况整理成提前汇报，保留已发生的模拟经过及依据。只返回 JSON：${reportFormat}。资料：${JSON.stringify({ node, situation })}`, simSignal)))
      await store.saveStoryNotice({ ...identity, kind: 'report', value: report })
      const answer = storyNoticeDecisionSchema.parse(parseStrictJson(await call(`你是当前子故事的直接上级导演。根据提前汇报决定继续、调整或终止当前子故事。只返回严格 JSON，包含 action（continue、adjust 或 terminate）及 reason，adjust 还须包含 direction。资料：${JSON.stringify({ parent, node, report })}`, simSignal)))
      await store.saveStoryNotice({ ...identity, kind: 'decision', value: answer })
      simSignal.throwIfAborted()
      if (answer.action === 'terminate') termination = answer
      return answer
    })().finally(() => { waiting = false })
    notices.set(id, { situation, response })
    return response
  }
  const reportEarly = (notice: StoryNoticeInput) => {
    const delivery = decideNotice(notice).then(answer => structuredClone(answer))
    // 模拟器即使未等待，本次演绎也会检查并回收汇报调用。
    void delivery.catch(() => {})
    return delivery
  }
  const recordSceneResult: StorySimulationInput['recordSceneResult'] = (sceneId, input) => {
    const write = (async () => {
      if (!accepting) throw new Error('演绎已经结束，不能保存场景结果')
      simSignal.throwIfAborted()
      await store.saveSceneResult(node.runId, node.storyId, sceneId, sceneResultInputSchema.parse(input))
    })()
    sceneWrites.add(write)
    const release = () => { sceneWrites.delete(write) }
    void write.then(release, release)
    return write
  }
  let simulation: Simulation
  try {
    const { runId, storyId, task } = node
    simulation = simulationSchema.parse(await options.simulate({ runId, storyId, task, preparation, reportEarly, recordSceneResult,
      ...(context.mapNeed ? { mapNeed: context.mapNeed } : {}) }, simSignal))
    accepting = false
    if (sceneWrites.size) throw new Error('模拟器在场景结果写入结束前返回')
    if (waiting) throw new Error('模拟器在收到上级决定前结束演绎')
    if (protocolError) throw protocolError
    simSignal.throwIfAborted()
    const decisions = await Promise.all([...notices.values()].map(notice => notice.response))
    return { simulation, decisions, termination }
  } finally {
    accepting = false
    if (waiting) lifecycle.abort()
    await Promise.allSettled([...notices.values()].map(notice => notice.response))
    await Promise.allSettled(sceneWrites)
  }
}
