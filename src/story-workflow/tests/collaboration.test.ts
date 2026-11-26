import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentFactory, AgentInstance } from '@fly-novel/agents'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { createStoryPlan } from '../../app/story-workflow.js'
import { readStoryCollaboration, readStorySimulation, readStorySiblingDecision, runStoryCollaboration, runStorySiblings, runStoryTree } from '../../app/story-workflow.js'
import { CollaborationStore } from '../store.js'

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
  for (let level = 9; level >= 2; level--) responses.push(levelReport(level), `第${level - 1}层接收第${level}层`)
  responses.push(proceed, task, direct, report, '上级收到货物结果', levelReport(1))
  const adapter = new ScriptedAdapter(responses)
  let simulated = 0
  const options = { ...baseOptions, adapter, simulate: async () => { simulated++; return simulation } }
  const result = await runStoryTree(options, plan.id)
  assert.equal(result.kind, 'result')
  assert.equal(simulated, 2)
  const files = await readdir(baseOptions.collaborationRoot)
  const storyFiles = files.filter(file => /\.story\.json$/.test(file) && !/\.(decision|simulation|result|choice)\.story\.json$/.test(file))
  assert.equal(storyFiles.length, 11)
  const nodes = await Promise.all(storyFiles.map(async file => JSON.parse(await readFile(join(baseOptions.collaborationRoot, file), 'utf8')) as { storyId: string; parentStoryId: string | null; description: string }))
  const first = nodes.find(node => node.description === '商队夜间抵达')!
  const root = nodes.find(node => node.parentStoryId === null)!
  assert.equal(first.parentStoryId, root.storyId)
  let parent = first
  const store = await CollaborationStore.open(baseOptions.collaborationRoot, baseOptions.planRoot, [])
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

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'story-collaboration-'))
  const { mkdir } = await import('node:fs/promises')
  const planRoot = join(base, 'plans'); const collaborationRoot = join(base, 'collaborations')
  await mkdir(planRoot); await mkdir(collaborationRoot)
  const baseOptions = { planRoot, collaborationRoot, protectedRoots: [] as string[], provider: 'test', model: 'test' }
  const plan = await createStoryPlan({ root: planRoot, protectedRoots: [collaborationRoot], provider: 'test', model: 'test', adapter: new ScriptedAdapter(['{"kind":"planned","events":["商队夜间抵达","处理货物"]}']) }, { task: '处理城防与商贸矛盾', facts: ['夜间城门关闭'], directions: ['城防与商贸可能趋紧'] })
  if (plan.outcome.kind !== 'planned') throw new Error('预期计划')
  return { base, baseOptions, plan, eventId: plan.outcome.events[0]!.id }
}

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
