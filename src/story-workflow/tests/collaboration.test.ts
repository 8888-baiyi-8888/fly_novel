import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentFactory, AgentInstance } from '@fly-novel/agents'
import { readStoryCollaboration, readStorySimulation, readStorySiblingDecision, runStoryCollaboration, runStorySiblings } from '../../app/story-workflow.js'
import { ScriptedAdapter, report, setup, simulation, task } from './fixtures.js'

test('独立父子导演完成任务交付、模拟回报和父导演接收', async t => {
  const { baseOptions, plan, eventId } = await setup(t)
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
  const { baseOptions, plan, eventId } = await setup(t)
  const disposals = t.mock.method(AgentInstance.prototype, 'dispose')
  const options = { ...baseOptions, adapter: new ScriptedAdapter([task, '准备交涉', '不是有效回报']), simulate: async () => simulation }
  await assert.rejects(runStoryCollaboration(options, plan.id, eventId), /未完成/)
  assert.equal(disposals.mock.callCount(), 2)
  assert.equal((await readStorySimulation(options, plan.id, eventId)).simulation.summary, '守卫拒绝开门')
  await assert.rejects(readStoryCollaboration(options, plan.id, eventId))
  await assert.rejects(runStoryCollaboration(options, plan.id, eventId), /已有尝试/)
})

test('协作记录版本损坏时拒绝读取并保留原文件', async t => {
  const { baseOptions, plan, eventId } = await setup(t)
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
  const { baseOptions, plan, eventId } = await setup(t)
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
  const { baseOptions, plan, eventId } = await setup(t)
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
    const { baseOptions, plan, eventId } = await setup(t)
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
  const { baseOptions, plan, eventId } = await setup(t)
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
  const { baseOptions, plan } = await setup(t)
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
    const { baseOptions, plan } = await setup(t)
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
