import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentFactory, AgentInstance } from '@fly-novel/agents'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { createStoryPlan } from '../../app/story-workflow.js'
import { readStoryCollaboration, readStorySimulation, runStoryCollaboration } from '../../app/story-workflow.js'

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
