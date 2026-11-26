import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentFactory, AgentInstance } from '@fly-novel/agents'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { continueStoryTree, createNextStoryPlan, createStoryPlan, readStoryRoundResult } from '../../app/story-workflow.js'
import { readStoryCollaboration, readStorySimulation, readStorySiblingDecision, runStoryCollaboration, runStorySiblings, runStoryTree } from '../../app/story-workflow.js'
import { CollaborationStore } from '../store.js'
import type { StoryTreeOptions } from '../../app/story-workflow.js'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly responses: string[]) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const content = this.responses.shift()
    if (content === undefined) throw new Error('缺少测试响应')
    yield { type: 'block-end', index: 0, block: { type: 'text', text: content } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const task = '{"background":"商队抵达","goal":"处理入城请求","constraints":["夜间城门关闭"]}'
const report = '{"summary":"守卫拒绝开门","changes":["商队扎营"],"unresolved":["货物"],"evidence":"模拟交涉经过"}'
const simulation = { kind: 'simulation' as const, summary: '守卫拒绝开门', changes: ['商队扎营'], unresolved: ['货物'], evidence: '模拟交涉经过' }

test('故事记录保存三层父子关系，拒绝缺失上级和覆盖已有记录', async t => {
  const { base, baseOptions } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const store = await CollaborationStore.open(baseOptions.collaborationRoot, baseOptions.planRoot, [])
  const runId = randomUUID()
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  const nodes = ids.map((storyId, index) => ({ formatVersion: 1 as const, runId, storyId, parentStoryId: index === 0 ? null : ids[index - 1]!, description: `故事${index}`, task: { background: '商队抵达', goal: '处理入城请求', constraints: ['夜间城门关闭'] } }))
  await assert.rejects(store.saveStoryNode(nodes[1]!))
  for (const node of nodes) await store.saveStoryNode(node)
  assert.deepEqual(await store.readStoryNode(runId, ids[2]!), nodes[2])
  await assert.rejects(store.saveStoryNode(nodes[0]!), /保存失败/)
  await assert.rejects(store.readStoryNode(randomUUID(), ids[2]!))
})

test('十层故事按深度推进，最深层结果逐层返回上级', async t => {
  const { base, baseOptions, plan } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const proceed = '{"decision":"continue","reason":"继续"}'
  const direct = '{"kind":"direct","preparation":"模拟城门"}'
  const levelReport = (level: number) => JSON.stringify({ summary: `第${level}层回报`, changes: ['商队扎营'], unresolved: ['货物'], evidence: '模拟交涉经过' })
  const responses: string[] = []
  for (let level = 2; level < 10; level++) responses.push(proceed, task, JSON.stringify({ kind: 'split', children: [`第${level + 1}层`] }))
  responses.push(proceed, task, direct, levelReport(10), '第9层接收第10层')
  const achieved = (level: number) => JSON.stringify({ status: 'achieved', reason: '下级模拟结果满足目标', report: JSON.parse(levelReport(level)) })
  for (let level = 9; level >= 2; level--) responses.push(achieved(level), `第${level - 1}层接收第${level}层`)
  responses.push(proceed, task, direct, report, '上级收到货物结果', achieved(1))
  const adapter = new ScriptedAdapter(responses)
  let simulated = 0
  const options = { ...baseOptions, adapter, simulate: async () => { simulated++; return simulation } }
  const result = await runStoryTree(options, plan.id)
  assert.equal(result.kind, 'result')
  assert.equal(simulated, 2)
  const files = await readdir(baseOptions.collaborationRoot)
  const storyFiles = files.filter(file => /^[\da-f-]+\.[\da-f-]+\.story\.json$/i.test(file))
  assert.equal(storyFiles.length, 11)
  const nodes = await Promise.all(storyFiles.map(async file => JSON.parse(await readFile(join(baseOptions.collaborationRoot, file), 'utf8')) as { storyId: string; parentStoryId: string | null; description: string }))
  const first = nodes.find(node => node.description === '商队夜间抵达')!
  const root = nodes.find(node => node.parentStoryId === null)!
  assert.equal(first.parentStoryId, root.storyId)
  let parent = first
  const store = await CollaborationStore.open(baseOptions.collaborationRoot, baseOptions.planRoot, [])
  const rootAssessment = await store.readStoryStep(plan.id, root.storyId, 'assessment')
  assert.equal(rootAssessment.kind === 'assessment' && rootAssessment.value.status, 'achieved')
  const firstResult = await store.readStoryStep(plan.id, first.storyId, 'result')
  assert.equal(firstResult.kind, 'result')
  if (firstResult.kind !== 'result') throw new Error('预期故事结果')
  assert.equal(firstResult.value.summary, '第2层回报')
  assert.equal(firstResult.receipt, '第1层接收第2层')
  assert.ok(adapter.requests.some(request => JSON.stringify(request.messages).includes('第2层回报') && JSON.stringify(request.messages).includes(root.storyId)))
  assert.equal(result.kind === 'result' && result.value.summary, '第1层回报')
  for (let level = 3; level <= 10; level++) {
    const child = nodes.find(node => node.description === `第${level}层`)!
    assert.equal(child.parentStoryId, parent.storyId)
    const saved = await store.readStoryStep(plan.id, child.storyId, 'result')
    assert.equal(saved.kind, 'result')
    if (saved.kind !== 'result') throw new Error('预期故事结果')
    assert.equal(saved.value.summary, `第${level}层回报`)
    assert.equal(saved.receipt, `第${level - 1}层接收第${level}层`)
    assert.ok(adapter.requests.some(request => JSON.stringify(request.messages).includes(`第${level}层回报`) && JSON.stringify(request.messages).includes(parent.storyId)))
    parent = child
  }
  assert.equal(nodes.find(node => node.description === '处理货物')?.parentStoryId, first.parentStoryId)
  assert.equal(files.filter(file => file.endsWith('.result.story.json')).length, 11)
})

test('父故事根据模拟回报评估，补充后仍未达成时保存调整', async t => {
  const { base, baseOptions, plan } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const proceed = '{"decision":"continue","reason":"继续"}'
  const direct = '{"kind":"direct","preparation":"模拟谈判"}'
  const supplement = '{"status":"supplement","reason":"货物仍未解决","description":"协商临时货场"}'
  const adjustment = '将目标调整为保管货物，入城留待后续处理'
  const unmet = JSON.stringify({ status: 'unmet', reason: '仍未获得入城许可', report: JSON.parse(report), adjustment })
  const adapter = new ScriptedAdapter([
    proceed, task, direct, report, '父导演收到拒绝结果',
    proceed, task, direct, report, '父导演收到货物结果',
    supplement,
    proceed, task, direct, report, '父导演收到补充结果',
    unmet,
  ])
  let simulated = 0
  const options = { ...baseOptions, adapter, simulate: async () => { simulated++; return simulation } }
  const result = await runStoryTree(options, plan.id)
  assert.equal(simulated, 3)
  assert.match(JSON.stringify(adapter.requests[10]?.messages), /父导演收到货物结果/)
  assert.match(JSON.stringify(adapter.requests[16]?.messages), /父导演收到补充结果/)
  const store = await CollaborationStore.open(baseOptions.collaborationRoot, baseOptions.planRoot, [])
  const saved = await store.readStoryStep(plan.id, result.storyId, 'assessment')
  assert.equal(saved.kind === 'assessment' && saved.value.status === 'unmet' && saved.value.adjustment, adjustment)
  const added = await store.readStoryStep(plan.id, result.storyId, 'supplement')
  assert.equal(added.kind, 'supplement')
  if (added.kind !== 'supplement') throw new Error('预期补充记录')
  assert.equal((await store.readStoryNode(plan.id, added.value.id)).parentStoryId, result.storyId)
})

test('补充机会用完后拒绝第二个补充故事', async t => {
  const { base, baseOptions, plan } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const cancel = '{"decision":"cancel","reason":"条件已变化"}'
  const supplement = '{"status":"supplement","reason":"尝试替代方案","description":"协商临时货场"}'
  const adapter = new ScriptedAdapter([cancel, cancel, supplement, cancel, supplement])
  const options = { ...baseOptions, adapter, simulate: async () => { throw new Error('取消项不应演绎') } }
  await assert.rejects(runStoryTree(options, plan.id), /最多补充一个/)
  const files = await readdir(baseOptions.collaborationRoot)
  assert.equal(files.filter(file => file.endsWith('.supplement.story.json')).length, 1)
  assert.equal(files.filter(file => file.endsWith('.result.story.json')).length, 0)
})

test('父故事可依据首个结果提前终止，保留未解决事项', async t => {
  const { base, baseOptions, plan } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const terminated = JSON.stringify({ status: 'terminated', reason: '守卫拒绝开门后已无法在城内继续', report: JSON.parse(report) })
  const adapter = new ScriptedAdapter(['{"decision":"continue","reason":"先交涉"}', task, '{"kind":"direct","preparation":"模拟城门"}', report, '收到拒绝结果', terminated])
  let simulated = 0
  const result = await runStoryTree({ ...baseOptions, adapter, simulate: async () => { simulated++; return simulation } }, plan.id)
  assert.equal(simulated, 1)
  assert.match(JSON.stringify(adapter.requests[5]?.messages), /收到拒绝结果/)
  const store = await CollaborationStore.open(baseOptions.collaborationRoot, baseOptions.planRoot, [])
  const assessment = await store.readStoryStep(plan.id, result.storyId, 'assessment')
  assert.equal(assessment.kind === 'assessment' && assessment.value.status, 'terminated')
  assert.deepEqual(assessment.kind === 'assessment' && assessment.value.report.unresolved, ['货物'])
})

test('中间层判断失败停止后续故事并释放导演', async t => {
  const { base, baseOptions, plan } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const dispose = t.mock.method(AgentInstance.prototype, 'dispose')
  let simulated = 0
  const adapter = new ScriptedAdapter(['{"decision":"continue","reason":"继续"}', task, '{"kind":"split","children":["交涉"]}', '无效判断'])
  const options = { ...baseOptions, adapter, simulate: async () => { simulated++; return simulation } }
  await assert.rejects(runStoryTree(options, plan.id))
  assert.equal(simulated, 0)
  assert.equal(dispose.mock.callCount(), 4)
  assert.equal((await readdir(baseOptions.collaborationRoot)).filter(file => file.endsWith('.result.story.json')).length, 0)
})

test('多层故事取消模拟时保留节点并停止后续处理', async t => {
  const { base, baseOptions, plan } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const controller = new AbortController()
  const adapter = new ScriptedAdapter(['{"decision":"continue","reason":"继续"}', task, '{"kind":"direct","preparation":"模拟城门"}'])
  const options = { ...baseOptions, adapter, simulate: async (_input: unknown, signal: AbortSignal) => { controller.abort(); signal.throwIfAborted(); return simulation } }
  await assert.rejects(runStoryTree(options, plan.id, controller.signal))
  const files = await readdir(baseOptions.collaborationRoot)
  assert.equal(files.filter(file => file.endsWith('.result.story.json')).length, 0)
  assert.equal(files.filter(file => file.endsWith('.choice.story.json')).length, 1)
})

test('中间层导演启动失败不会继续执行兄弟故事', async t => {
  const { base, baseOptions, plan } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const original = AgentFactory.prototype.create
  let calls = 0
  t.mock.method(AgentFactory.prototype, 'create', async function (this: AgentFactory, config: Parameters<AgentFactory['create']>[0]) {
    if (++calls === 4) throw new Error('中间层导演启动失败')
    return original.call(this, config)
  })
  const dispose = t.mock.method(AgentInstance.prototype, 'dispose')
  const adapter = new ScriptedAdapter(['{"decision":"continue","reason":"继续"}', task, '{"kind":"split","children":["交涉"]}'])
  const options = { ...baseOptions, adapter, simulate: async () => simulation }
  await assert.rejects(runStoryTree(options, plan.id), /中间层导演启动失败/)
  assert.equal(calls, 4)
  assert.equal(dispose.mock.callCount(), 3)
  assert.equal((await readdir(baseOptions.collaborationRoot)).filter(file => file.endsWith('.result.story.json')).length, 0)
})

async function setup(events = ['商队夜间抵达', '处理货物']) {
  const base = await mkdtemp(join(tmpdir(), 'story-collaboration-'))
  const { mkdir } = await import('node:fs/promises')
  const planRoot = join(base, 'plans'); const collaborationRoot = join(base, 'collaborations')
  await mkdir(planRoot); await mkdir(collaborationRoot)
  const baseOptions = { planRoot, collaborationRoot, protectedRoots: [] as string[], provider: 'test', model: 'test' }
  const plan = await createStoryPlan({ root: planRoot, protectedRoots: [collaborationRoot], provider: 'test', model: 'test', adapter: new ScriptedAdapter([JSON.stringify({ kind: 'planned', events })]) }, { task: '处理城防与商贸矛盾', facts: ['夜间城门关闭'], directions: ['城防与商贸可能趋紧'] })
  if (plan.outcome.kind !== 'planned') throw new Error('预期计划')
  return { base, baseOptions, plan, eventId: plan.outcome.events[0]!.id }
}

const advance = '{"decision":"continue","reason":"继续"}'
const leaf = (name: string) => [advance, task, JSON.stringify({ kind: 'direct', preparation: name }), report, '已接收']
const achieved = JSON.stringify({ status: 'achieved', reason: '目标达成', report: JSON.parse(report) })

test('曲水城整轮演化跨批次推进，结束后使用更新资料开始下一轮', async t => {
  const { base, baseOptions, plan } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const notification = { id: randomUUID(), situation: '城门外道路积水' }
  const played: string[] = []
  const simulate: StoryTreeOptions['simulate'] = async ({ preparation, reportEarly }) => {
    played.push(preparation)
    if (preparation === '查验身份') {
      const decision = await reportEarly(notification)
      assert.deepEqual(decision, { action: 'adjust', reason: '积水影响城门', direction: '转移至高地' })
      played.push(decision.direction)
    }
    return simulation
  }
  const first = leaf('查验身份')
  const noticeReport = JSON.stringify({ summary: '道路积水', changes: ['城外道路受阻'], unresolved: ['商队等候点'], evidence: '模拟观察' })
  first.splice(3, 0, noticeReport, '{"action":"adjust","reason":"积水影响城门","direction":"转移至高地"}')
  const paused = await runStoryTree({ ...baseOptions, limit: 1, simulate, adapter: new ScriptedAdapter([
    advance, task, '{"kind":"split","children":["查验身份","交涉入城"]}', ...first,
  ]) }, plan.id)
  if (paused.kind !== 'paused') throw new Error('预期在第一批后暂停')
  const nextInput = { task: '规划商队天亮后的行动', facts: ['用户提供的新一轮局势：商队已得到临时仓位'], directions: ['重启商贸'] }
  const planning = { root: baseOptions.planRoot, collaborationRoot: baseOptions.collaborationRoot, protectedRoots: [], provider: 'test', model: 'test', adapter: new ScriptedAdapter(['{"kind":"planned","events":["办理天亮后的入城手续"]}']) }
  await assert.rejects(createNextStoryPlan(planning, plan.id, nextInput), { code: 'ENOENT' })
  assert.equal(planning.adapter.requests.length, 0)

  const pausePath = join(baseOptions.collaborationRoot, `${plan.id}.${paused.batch}.paused.story.json`)
  const savedProgress = await readFile(pausePath, 'utf8')
  const batchOptions = { ...baseOptions, limit: 2, simulate, adapter: new ScriptedAdapter([
    ...leaf('交涉入城'), '{"status":"supplement","reason":"仍需转移货物","description":"协商临时仓位"}',
    ...leaf('协商临时仓位'), achieved, '根导演收到城门故事回报',
  ]) }
  for (const invalid of [savedProgress.replace('"formatVersion": 1', '"formatVersion": 99'), '{']) {
    await writeFile(pausePath, invalid)
    await assert.rejects(continueStoryTree(batchOptions, plan.id, paused.batch))
    assert.equal(await readFile(pausePath, 'utf8'), invalid)
  }
  assert.equal(batchOptions.adapter.requests.length, 0)
  await writeFile(pausePath, savedProgress)
  const attempts = await Promise.allSettled([
    continueStoryTree(batchOptions, plan.id, paused.batch),
    continueStoryTree(batchOptions, plan.id, paused.batch),
  ])
  const accepted = attempts.find(attempt => attempt.status === 'fulfilled')
  const rejected = attempts.find(attempt => attempt.status === 'rejected')
  assert.match(String(rejected?.reason), /已使用/)
  if (!accepted || accepted.value.kind !== 'paused') throw new Error('预期在第二批后暂停')
  assert.equal(accepted.value.completedCount, 2)
  assert.match(JSON.stringify(batchOptions.adapter.requests[0]?.messages), /守卫拒绝开门/)

  const ended = await continueStoryTree({ ...baseOptions, simulate, adapter: new ScriptedAdapter([...leaf('处理货物'), achieved]) }, plan.id, accepted.value.batch)
  assert.equal(ended.kind, 'result')
  assert.equal(ended.completedCount, 1)
  assert.deepEqual(played, ['查验身份', '转移至高地', '交涉入城', '协商临时仓位', '处理货物'])
  const saved = await readStoryRoundResult(baseOptions, plan.id)
  assert.equal(saved.result.storyId, ended.storyId)
  assert.equal(saved.assessment.status, 'achieved')
  const next = await createNextStoryPlan(planning, plan.id, nextInput)
  assert.notEqual(next.id, plan.id)
  assert.deepEqual(next.input, nextInput)
  assert.match(JSON.stringify(planning.adapter.requests[0]?.messages), /商队已得到临时仓位/)
  const nextEnd = await runStoryTree({ ...baseOptions, simulate, adapter: new ScriptedAdapter([...leaf('办理入城手续'), achieved]) }, next.id)
  assert.equal(nextEnd.kind, 'result')
  assert.equal((await readStoryRoundResult(baseOptions, plan.id)).result.storyId, ended.storyId)
})

test('提前汇报交给直接上级，重复通知只判断一次，调整决定交回模拟器', async t => {
  const { base, baseOptions, plan, eventId } = await setup(['城门交涉'])
  t.after(() => rm(base, { recursive: true, force: true }))
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
  const { base, baseOptions, plan, eventId } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
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
    const { base, baseOptions, plan, eventId } = await setup()
    t.after(() => rm(base, { recursive: true, force: true }))
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

test('默认演绎五个最小故事，继续时使用新数量且不重复演绎', async t => {
  const events = Array.from({ length: 7 }, (_, i) => `事件${i + 1}`)
  const { base, baseOptions, plan } = await setup(events)
  t.after(() => rm(base, { recursive: true, force: true }))
  const seen: string[] = []
  const simulate = async ({ preparation }: { preparation: string }) => { seen.push(preparation); return simulation }
  const start = await runStoryTree({ ...baseOptions, simulate, adapter: new ScriptedAdapter(events.slice(0, 5).flatMap(leaf)) }, plan.id)
  assert.equal(start.kind, 'paused')
  if (start.kind !== 'paused') throw new Error('预期暂停')
  assert.equal(start.completedCount, 5)
  assert.deepEqual(seen, events.slice(0, 5))
  const options = { ...baseOptions, simulate, limit: 2, adapter: new ScriptedAdapter([...events.slice(5).flatMap(leaf), achieved]) }
  const end = await continueStoryTree(options, plan.id, start.batch)
  assert.equal(end.kind, 'result')
  assert.equal(end.completedCount, 2)
  assert.equal(end.storyId, start.storyId)
  assert.deepEqual(seen, events)
  await assert.rejects(continueStoryTree(options, plan.id, start.batch), /已使用/)
})

test('暂停保留运行中的父故事，下次继续跨层推进', async t => {
  const { base, baseOptions, plan } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const seen: string[] = []
  const simulate = async ({ preparation }: { preparation: string }) => { seen.push(preparation); return simulation }
  const start = await runStoryTree({ ...baseOptions, limit: 1, simulate, adapter: new ScriptedAdapter([
    advance, task, '{"kind":"split","children":["核对身份","进行交涉"]}', ...leaf('核对身份'),
  ]) }, plan.id)
  assert.equal(start.kind, 'paused')
  if (start.kind !== 'paused') throw new Error('预期暂停')
  assert.equal(start.completedCount, 1)
  const adapter = new ScriptedAdapter([...leaf('进行交涉'), achieved, '收到城门故事回报', ...leaf('处理货物'), achieved])
  const end = await continueStoryTree({ ...baseOptions, limit: 2, simulate, adapter }, plan.id, start.batch)
  assert.equal(end.kind, 'result')
  assert.equal(end.completedCount, 2)
  assert.match(JSON.stringify(adapter.requests[0]?.messages), /守卫拒绝开门/)
  assert.deepEqual(seen, ['核对身份', '进行交涉', '处理货物'])
})

test('继续后演绎失败时不生成新的可继续位置', async t => {
  const { base, baseOptions, plan } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const start = await runStoryTree({ ...baseOptions, limit: 1, simulate: async () => simulation, adapter: new ScriptedAdapter(leaf('城门')) }, plan.id)
  if (start.kind !== 'paused') throw new Error('预期暂停')
  const options = { ...baseOptions, limit: 1, simulate: async () => { throw new Error('演绎失败') }, adapter: new ScriptedAdapter(leaf('货物')) }
  await assert.rejects(continueStoryTree(options, plan.id, start.batch), /演绎失败/)
  assert.equal((await readdir(baseOptions.collaborationRoot)).filter(file => file.endsWith('.paused.story.json')).length, 1)
  await assert.rejects(continueStoryTree(options, plan.id, start.batch), /已使用/)
})

test('继续时校验已保存结果，实际取消的演绎不计入完成', async t => {
  const { base, baseOptions, plan } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  if (plan.outcome.kind !== 'planned') throw new Error('预期计划')
  const start = await runStoryTree({ ...baseOptions, limit: 1, simulate: async () => simulation, adapter: new ScriptedAdapter(leaf('城门')) }, plan.id)
  if (start.kind !== 'paused') throw new Error('预期暂停')
  const [first, second] = plan.outcome.events
  const path = join(baseOptions.collaborationRoot, `${plan.id}.${first!.id}.result.story.json`)
  const original = await readFile(path, 'utf8')
  await writeFile(path, original.replace('已接收', '结果已变化'))
  const controller = new AbortController()
  const adapter = new ScriptedAdapter(leaf('货物'))
  const options = { ...baseOptions, limit: 1, adapter, simulate: async () => { controller.abort(); return simulation } }
  await assert.rejects(continueStoryTree(options, plan.id, start.batch), /子故事结果不匹配/)
  assert.equal(adapter.requests.length, 0)
  await writeFile(path, original)
  await assert.rejects(continueStoryTree(options, plan.id, start.batch, controller.signal), { name: 'AbortError' })
  const files = await readdir(baseOptions.collaborationRoot)
  assert.equal(files.filter(file => file.endsWith('.paused.story.json')).length, 1)
  assert.ok(!files.includes(`${plan.id}.${second!.id}.result.story.json`))
})

test('独立父子导演完成任务交付、模拟回报和父导演接收', async t => {
  const { base, baseOptions, plan, eventId } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const factory = t.mock.method(AgentFactory.prototype, 'create')
  const disposals = t.mock.method(AgentInstance.prototype, 'dispose')
  const adapter = new ScriptedAdapter([task, '准备城门交涉', report, '收到：守卫拒绝，货物仍未处理'])
  let simulationCalls = 0
  const options = { ...baseOptions, adapter, simulate: async (input: { task: { goal: string }; preparation: string }) => { simulationCalls++; assert.equal(input.task.goal, '处理入城请求'); assert.equal(input.preparation, '准备城门交涉'); return simulation } }
  const result = await runStoryCollaboration(options, plan.id, eventId)
  assert.equal(result.plan.id, plan.id)
  assert.equal(result.childStoryId, eventId)
  assert.equal(result.simulation.kind, 'simulation')
  assert.equal(result.report.summary, '守卫拒绝开门')
  assert.match(result.parentReceipt, /货物仍未处理/)
  assert.deepEqual(await readStoryCollaboration(options, plan.id, eventId), result)
  assert.equal(simulationCalls, 1)
  assert.equal(factory.mock.callCount(), 2)
  assert.notEqual(factory.mock.calls[0]?.arguments[0].id, factory.mock.calls[1]?.arguments[0].id)
  assert.deepEqual(factory.mock.calls.map(call => call.arguments[0].presetId), ['director-agent', 'director-agent'])
  assert.equal(disposals.mock.callCount(), 2)
  assert.match(JSON.stringify(adapter.requests[1]?.messages), /处理入城请求/)
  assert.match(JSON.stringify(adapter.requests[2]?.messages), /模拟交涉经过/)
  assert.match(JSON.stringify(adapter.requests[3]?.messages), /守卫拒绝开门/)
  assert.doesNotMatch(JSON.stringify(adapter.requests[1]?.messages), /城防与商贸可能趋紧/)
  assert.equal(adapter.requests[2]?.messages.filter(message => message.role === 'user').length, 2)
  assert.equal(adapter.requests[3]?.messages.filter(message => message.role === 'user').length, 2)
  await assert.rejects(runStoryCollaboration(options, plan.id, eventId), /已有尝试/)
  assert.equal(simulationCalls, 1)
})

test('子导演回报失败时两个导演均释放，不产生完成结果', async t => {
  const { base, baseOptions, plan, eventId } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const disposals = t.mock.method(AgentInstance.prototype, 'dispose')
  const options = { ...baseOptions, adapter: new ScriptedAdapter([task, '准备交涉', '不是有效回报']), simulate: async () => simulation }
  await assert.rejects(runStoryCollaboration(options, plan.id, eventId), /未完成/)
  assert.equal(disposals.mock.callCount(), 2)
  assert.equal((await readStorySimulation(options, plan.id, eventId)).simulation.summary, '守卫拒绝开门')
  await assert.rejects(readStoryCollaboration(options, plan.id, eventId))
  await assert.rejects(runStoryCollaboration(options, plan.id, eventId), /已有尝试/)
})

test('协作记录版本损坏时拒绝读取并保留原文件', async t => {
  const { base, baseOptions, plan, eventId } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const options = { ...baseOptions, adapter: new ScriptedAdapter([task, '准备交涉', report, '已接收']), simulate: async () => simulation }
  await runStoryCollaboration(options, plan.id, eventId)
  const path = join(baseOptions.collaborationRoot, `${plan.id}.${eventId}.result.json`)
  const original = await readFile(path, 'utf8')
  const corrupted = original.replace('"formatVersion": 1', '"formatVersion": 9')
  await writeFile(path, corrupted)
  await assert.rejects(readStoryCollaboration(options, plan.id, eventId))
  assert.equal(await readFile(path, 'utf8'), corrupted)
})

test('模型不能选择子导演 Preset，非法任务拒绝启动子导演', async t => {
  const { base, baseOptions, plan, eventId } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const factory = t.mock.method(AgentFactory.prototype, 'create')
  const adapter = new ScriptedAdapter(['{"background":"背景","goal":"目标","constraints":[],"presetId":"writer-agent"}'])
  let called = false
  const options = { ...baseOptions, adapter, simulate: async () => { called = true; return simulation } }
  await assert.rejects(runStoryCollaboration(options, plan.id, eventId), /未完成/)
  assert.equal(called, false)
  assert.equal(factory.mock.callCount(), 1)
  assert.equal(factory.mock.calls[0]?.arguments[0].presetId, 'director-agent')
  await assert.rejects(readStoryCollaboration(options, plan.id, eventId))
})

test('子导演启动失败后父导演释放，保留占用并拒绝重复执行', async t => {
  const { base, baseOptions, plan, eventId } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const original = AgentFactory.prototype.create
  let calls = 0
  const factory = t.mock.method(AgentFactory.prototype, 'create', async function (this: AgentFactory, options: Parameters<AgentFactory['create']>[0]) {
    calls++
    if (calls === 2) return original.call(this, { ...options, pluginConfigs: { ...options.pluginConfigs, 'agent-loop-runtime': {} } })
    return original.call(this, options)
  })
  const dispose = t.mock.method(AgentInstance.prototype, 'dispose')
  let called = false
  const options = { ...baseOptions, adapter: new ScriptedAdapter([task]), simulate: async () => { called = true; return simulation } }
  await assert.rejects(runStoryCollaboration(options, plan.id, eventId), /未完成/)
  assert.equal(factory.mock.callCount(), 2)
  assert.equal(dispose.mock.callCount(), 1)
  assert.equal(called, false)
  await assert.rejects(runStoryCollaboration(options, plan.id, eventId), /已有尝试/)
  assert.equal((await readdir(baseOptions.collaborationRoot)).length, 1)
})

test('模拟失败和取消均保留占用，不将事件记为完成', async t => {
  for (const mode of ['failure', 'cancel'] as const) {
    const { base, baseOptions, plan, eventId } = await setup()
    t.after(() => rm(base, { recursive: true, force: true }))
    const disposals = t.mock.method(AgentInstance.prototype, 'dispose')
    let notify!: () => void
    const started = new Promise<void>(resolve => { notify = resolve })
    const controller = new AbortController()
    const options = { ...baseOptions, adapter: new ScriptedAdapter([task, '准备交涉']), simulate: async (_input: unknown, signal: AbortSignal) => {
      notify()
      if (mode === 'failure') throw new Error('模拟失败')
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
      signal.throwIfAborted()
      return simulation
    } }
    const running = runStoryCollaboration(options, plan.id, eventId, controller.signal)
    if (mode === 'cancel') { await started; controller.abort() }
    await assert.rejects(running, /未完成/)
    assert.equal(disposals.mock.callCount(), 2)
    await assert.rejects(readStoryCollaboration(options, plan.id, eventId))
    await assert.rejects(runStoryCollaboration(options, plan.id, eventId), /已有尝试/)
    disposals.mock.restore()
  }
})

test('保存记录时发现规划变化则停止，已损坏记录不会被覆盖', async t => {
  const { base, baseOptions, plan, eventId } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  const path = join(baseOptions.planRoot, `${plan.id}.json`)
  const original = await readFile(path, 'utf8')
  const options = { ...baseOptions, adapter: new ScriptedAdapter([task, '准备交涉', report, '收到回报']), simulate: async () => {
    await writeFile(path, original.replace('城防与商贸可能趋紧', '城防与商贸可能恶化'))
    return simulation
  } }
  await assert.rejects(runStoryCollaboration(options, plan.id, eventId), /规划已变化/)
  assert.match(await readFile(path, 'utf8'), /可能恶化/)
  await assert.rejects(readStoryCollaboration(options, plan.id, eventId))
})

test('兄弟故事顺序使用前一项的模拟回报，调整决定和父故事身份得到保存', async t => {
  const { base, baseOptions, plan } = await setup()
  t.after(() => rm(base, { recursive: true, force: true }))
  if (plan.outcome.kind !== 'planned') throw new Error('预期计划')
  const adapter = new ScriptedAdapter([
    '{"decision":"continue","reason":"先处理商队抵达"}', task, '准备城门交涉', report, '收到商队在城外扎营',
    '{"decision":"adjust","reason":"商队在城外，改为处理城外货物"}',
    '{"background":"商队在城外扎营","goal":"处理城外货物","constraints":["夜间城门关闭"]}', '准备城外货物', report, '收到货物处理回报',
  ])
  const goals: string[] = []
  const options = { ...baseOptions, adapter, simulate: async (input: { task: { goal: string } }) => { goals.push(input.task.goal); return simulation } }
  const output = await runStorySiblings(options, plan.id)
  assert.deepEqual(goals, ['处理入城请求', '处理城外货物'])
  assert.equal(output.results.length, 2)
  assert.equal(output.results[0]?.parentStoryId, output.results[1]?.parentStoryId)
  assert.equal(output.decisions[1]?.decision, 'adjust')
  assert.deepEqual(await readStorySiblingDecision(options, plan.id, plan.outcome.events[1]!.id), output.decisions[1])
  assert.match(JSON.stringify(adapter.requests[5]?.messages), /商队扎营/)
  assert.match(JSON.stringify(adapter.requests[6]?.messages), /商队扎营/)
  await assert.rejects(runStorySiblings(options, plan.id), /已有运行/)
})

test('取消的兄弟故事不演绎；前项失败时不启动后项', async t => {
  for (const mode of ['cancel', 'failure'] as const) {
    const { base, baseOptions, plan } = await setup()
    t.after(() => rm(base, { recursive: true, force: true }))
    if (plan.outcome.kind !== 'planned') throw new Error('预期计划')
    const responses = mode === 'cancel'
      ? ['{"decision":"cancel","reason":"已不适合发生"}', '{"decision":"continue","reason":"继续处理"}', task, '准备交涉', report, '收到回报']
      : ['{"decision":"continue","reason":"继续"}', task, '准备交涉']
    let simulations = 0
    const options = { ...baseOptions, adapter: new ScriptedAdapter(responses), simulate: async () => { simulations++; if (mode === 'failure') throw new Error('模拟失败'); return simulation } }
    if (mode === 'cancel') {
      const result = await runStorySiblings(options, plan.id)
      assert.equal(result.results.length, 1)
      assert.equal(result.results[0]?.childStoryId, plan.outcome.events[1]?.id)
      assert.equal((await readStorySiblingDecision(options, plan.id, plan.outcome.events[0]!.id)).decision, 'cancel')
    } else {
      await assert.rejects(runStorySiblings(options, plan.id), /未完成/)
      await assert.rejects(readStorySiblingDecision(options, plan.id, plan.outcome.events[1]!.id))
    }
    assert.equal(simulations, 1)
  }
})
