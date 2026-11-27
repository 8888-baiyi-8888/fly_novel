import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { AgentInstance } from '@fly-novel/agents'
import { type GenerateOptions } from '@fly-novel/llm'
import { runStoryTree, type StoryTreeOptions } from '../../app/story-workflow.js'
import { CollaborationStore } from '../store.js'
import { ScriptedAdapter, achieved, advance, leaf, report, setup, simulation, task } from './fixtures.js'

test('提前汇报交给直接上级，重复通知只判断一次，调整决定交回模拟器', async t => {
  const { baseOptions, plan, eventId } = await setup(t, ['城门交涉'])
  const id = randomUUID()
  const early = JSON.stringify({ summary: '城外出现洪水', changes: [], unresolved: ['商队安置'], evidence: '水势上涨' })
  const adjustment = { action: 'adjust', reason: '原路线已不可用', direction: '改从高处撤离' }
  const [choose, giveTask, direct, final, receipt] = leaf('准备交涉')
  const adapter = new ScriptedAdapter([advance, task, '{"kind":"split","children":["查验城门"]}', choose!, giveTask!, direct!, early, JSON.stringify(adjustment), final!, receipt!, achieved, '根导演收到回报', achieved])
  const simulate: StoryTreeOptions['simulate'] = async ({ reportEarly }) => {
    const input = { id, situation: '发现城外洪水' }
    assert.deepEqual(await Promise.all([reportEarly(input), reportEarly(input)]), [adjustment, adjustment])
    return simulation
  }
  const result = await runStoryTree({ ...baseOptions, adapter, simulate }, plan.id)
  assert.equal(result.completedCount, 1)
  const store = await CollaborationStore.open(baseOptions.collaborationRoot, baseOptions.planRoot, [])
  const split = await store.readStoryStep(plan.id, eventId, 'decision')
  if (split.kind !== 'decision' || split.value.kind !== 'split') throw new Error('预期拆分安排')
  const childId = split.value.children[0]!.id
  const saved = await store.readStoryNotice(plan.id, childId, id, 'decision')
  assert.equal(saved.parentStoryId, eventId)
  assert.deepEqual(saved.value, adjustment)
  const requests = adapter.requests.map(request => JSON.stringify(request.messages))
  assert.equal(requests.filter(message => message.includes('直接上级导演') && message.includes('城外出现洪水')).length, 1)
  assert.match(requests[7]!, new RegExp(eventId))
  assert.match(requests[8]!, /改从高处撤离/)
  const finalResult = await store.readStoryStep(plan.id, childId, 'result')
  assert.equal(finalResult.kind === 'result' && finalResult.value.summary, '守卫拒绝开门')
})

test('提前决定可以继续或终止，终止的子故事不占用本次演绎数量', async t => {
  const { baseOptions, plan, eventId } = await setup(t)
  const [choose, giveTask, direct, final, receipt] = leaf('交涉')
  const adapter = new ScriptedAdapter([
    choose!, giveTask!, direct!, report, '{"action":"terminate","reason":"城门结构不稳"}', final!, receipt!,
    choose!, giveTask!, direct!, report, '{"action":"continue","reason":"风险解除"}', final!, receipt!, achieved,
  ])
  const decisions: string[] = []
  const simulate: StoryTreeOptions['simulate'] = async ({ reportEarly }) => {
    const answer = await reportEarly({ id: randomUUID(), situation: '城门异常' })
    decisions.push(answer.action)
    return simulation
  }
  const result = await runStoryTree({ ...baseOptions, adapter, simulate, limit: 1 }, plan.id)
  assert.deepEqual(decisions, ['terminate', 'continue'])
  assert.equal(result.kind, 'result')
  assert.equal(result.completedCount, 1)
  const store = await CollaborationStore.open(baseOptions.collaborationRoot, baseOptions.planRoot, [])
  const stopped = await store.readStoryStep(plan.id, eventId, 'assessment')
  assert.equal(stopped.kind === 'assessment' && stopped.value.status, 'terminated')
})

test('提前汇报后的上级失败或取消会保留汇报并释放导演', async t => {
  for (const mode of ['failure', 'cancel']) {
    const { baseOptions, plan, eventId } = await setup(t)
    const controller = new AbortController()
    const id = randomUUID()
    const [choose, giveTask, direct] = leaf('交涉')
    const adapter = new ScriptedAdapter([choose!, giveTask!, direct!, report, '无效决定'])
    const original = adapter.stream.bind(adapter)
    t.mock.method(adapter, 'stream', async function* (options: GenerateOptions) {
      if (mode === 'cancel' && JSON.stringify(options.messages).includes('根据提前汇报决定')) controller.abort()
      yield* original(options)
    })
    const disposals = t.mock.method(AgentInstance.prototype, 'dispose')
    const simulate: StoryTreeOptions['simulate'] = async ({ reportEarly }) => {
      await reportEarly({ id, situation: '城门异常' })
      throw new Error('不应收到决定')
    }
    await assert.rejects(runStoryTree({ ...baseOptions, adapter, simulate }, plan.id, controller.signal))
    assert.equal(disposals.mock.callCount(), 5)
    disposals.mock.restore()
    const store = await CollaborationStore.open(baseOptions.collaborationRoot, baseOptions.planRoot, [])
    assert.equal((await store.readStoryNotice(plan.id, eventId, id, 'report')).kind, 'report')
    await assert.rejects(store.readStoryNotice(plan.id, eventId, id, 'decision'), { code: 'ENOENT' })
    await assert.rejects(store.readStoryStep(plan.id, eventId, 'result'), { code: 'ENOENT' })
  }
})
