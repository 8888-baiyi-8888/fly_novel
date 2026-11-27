import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentFactory, AgentInstance } from '@fly-novel/agents'
import { createStoryPlan, readStory, runStoryTree } from '../../app/story-workflow.js'
import { CollaborationStore } from '../store.js'
import { ScriptedAdapter, achieved, advance, createTestDirectory, leaf, report, setup, simulation, task } from './fixtures.js'

test('父导演不能仅凭回报把尚未应用的状态目标判为达成', async t => {
  const root = await createTestDirectory(t, 'world-assessment-')
  const planRoot = join(root, 'plans'); const collaborationRoot = join(root, 'collaborations')
  await Promise.all([mkdir(planRoot), mkdir(collaborationRoot)])
  const worldId = '曲水城验收世界'
  const content = '商队已抵达，尚未安置'
  const digest = createHash('sha256').update(content).digest('hex')
  const providerOptions = { protectedRoots: [], provider: 'test', model: 'test' }
  const plan = await createStoryPlan({ ...providerOptions, root: planRoot, adapter: new ScriptedAdapter(['{"kind":"planned","events":["尝试安置商队"]}']) }, {
    task: '安全安置商队', facts: [], directions: [], world: { worldId, deliveryId: randomUUID(), deliveryVersion: 'fixture', reviewVersion: 'fixture',
      materials: [{ category: 'current', source: { kind: 'fixed', id: 'convoy-start' }, version: '1', content, digest }], notes: [], uncovered: [], deferred: [] },
  })
  const convoyId = randomUUID()
  const roots = { planRoot, collaborationRoot, protectedRoots: [] }
  const adapter = new ScriptedAdapter([...leaf('尝试安置'), achieved])
  await assert.rejects(runStoryTree({ ...providerOptions, ...roots, adapter, simulate: async () => simulation,
    worldProgress: { worldId, runId: plan.id, current: async () => ({ worldId, convoyId, digest, revision: 0, status: 'arrived' }),
      event: async () => { throw new Error('独立验收不读取场景事件') } },
    worldObjectives: [{ id: 'safe-wait', description: '车队已安全停稳', criterion: { kind: 'convoy-waiting' } }],
  }, plan.id), /目标证据不一致/)
  const story = await readStory(roots, plan.id)
  assert.equal(story.result, undefined)
  assert.equal(story.children[0]?.status, 'completed')
})

test('只读查询从曲水城规划重读三层故事及取消、待启动和已完成子项', async t => {
  const { baseOptions, plan } = await setup(t)
  const adapter = new ScriptedAdapter([
    advance, task, '{"kind":"split","children":["改走侧门","交涉入城"]}',
    '{"decision":"cancel","reason":"侧门关闭"}', ...leaf('交涉入城'), achieved, '收到入城回报',
  ])
  const pause = await runStoryTree({ ...baseOptions, limit: 1, adapter, simulate: async () => simulation }, plan.id)
  assert.equal(pause.kind, 'paused')
  const root = await readStory(baseOptions, plan.id)
  assert.equal(root.node.storyId, pause.storyId)
  assert.equal(root.parent, null)
  assert.equal(root.siblingIndex, null)
  assert.equal(root.result, undefined)
  assert.deepEqual(root.children.map(child => [child.description, child.status]), [
    ['商队夜间抵达', 'completed'], ['处理货物', 'planned'],
  ])

  const parent = await readStory(baseOptions, plan.id, root.children[0]!.id)
  assert.equal(parent.parent?.storyId, root.node.storyId)
  assert.equal(parent.siblingIndex, 0)
  assert.deepEqual(parent.children.map(child => [child.description, child.status]), [
    ['改走侧门', 'cancelled'], ['交涉入城', 'completed'],
  ])
  const child = await readStory(baseOptions, plan.id, parent.children[1]!.id)
  assert.equal(child.parent?.storyId, parent.node.storyId)
  assert.equal(child.siblingIndex, 1)
  assert.equal(child.node.task.goal, '处理入城请求')
  assert.equal(child.result?.value.summary, '守卫拒绝开门')
  assert.deepEqual(child.children, [])

  const before = await readdir(baseOptions.collaborationRoot)
  assert.ok(!before.some(file => file.endsWith('.continued.story.json')))
  const other = await setup(t)
  await runStoryTree({
    ...other.baseOptions, adapter: new ScriptedAdapter([...leaf('处理商队'), ...leaf('处理货物'), achieved]),
    simulate: async () => simulation,
  }, other.plan.id)
  await assert.rejects(readStory(other.baseOptions, other.plan.id, child.node.storyId), { code: 'ENOENT' })
  await assert.rejects(readStory(baseOptions, plan.id, root.children[1]!.id), { code: 'ENOENT' })
  assert.deepEqual(await readdir(baseOptions.collaborationRoot), before)

  const nodePath = join(baseOptions.collaborationRoot, `${plan.id}.${child.node.storyId}.story.json`)
  const original = await readFile(nodePath, 'utf8')
  await writeFile(nodePath, JSON.stringify({ ...child.node, parentStoryId: root.node.storyId }))
  await assert.rejects(readStory(baseOptions, plan.id, child.node.storyId), /上级安排不匹配/)
  await assert.rejects(readStory(baseOptions, plan.id, parent.node.storyId), /上级安排不匹配/)
  await writeFile(nodePath, original)

  const simulationPath = join(baseOptions.collaborationRoot, `${plan.id}.${child.node.storyId}.simulation.story.json`)
  await rename(simulationPath, `${simulationPath}.bak`)
  assert.equal((await readStory(baseOptions, plan.id, child.node.storyId)).result, undefined)
  assert.equal((await readStory(baseOptions, plan.id, parent.node.storyId)).children[1]?.status, 'incomplete')

  const parentPath = join(baseOptions.collaborationRoot, `${plan.id}.${parent.node.storyId}.story.json`)
  await rename(parentPath, `${parentPath}.bak`)
  await assert.rejects(readStory(baseOptions, plan.id, child.node.storyId), { code: 'ENOENT' })
  assert.equal((await readStory(baseOptions, plan.id)).children[0]?.status, 'incomplete')
})

test('故事记录保存三层父子关系，拒绝缺失上级和覆盖已有记录', async t => {
  const { baseOptions } = await setup(t)
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
  const { baseOptions, plan } = await setup(t)
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
  const { baseOptions, plan } = await setup(t)
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
  const { baseOptions, plan } = await setup(t)
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
  const { baseOptions, plan } = await setup(t)
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
  const { baseOptions, plan } = await setup(t)
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
  const { baseOptions, plan } = await setup(t)
  const controller = new AbortController()
  const adapter = new ScriptedAdapter(['{"decision":"continue","reason":"继续"}', task, '{"kind":"direct","preparation":"模拟城门"}'])
  const options = { ...baseOptions, adapter, simulate: async (_input: unknown, signal: AbortSignal) => { controller.abort(); signal.throwIfAborted(); return simulation } }
  await assert.rejects(runStoryTree(options, plan.id, controller.signal))
  const files = await readdir(baseOptions.collaborationRoot)
  assert.equal(files.filter(file => file.endsWith('.result.story.json')).length, 0)
  assert.equal(files.filter(file => file.endsWith('.choice.story.json')).length, 1)
})

test('中间层导演启动失败不会继续执行兄弟故事', async t => {
  const { baseOptions, plan } = await setup(t)
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
