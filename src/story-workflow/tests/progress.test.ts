import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { continueStoryTree, createStoryScene, inspectStoryProgress, readStory, runStoryTree } from '../../app/story-workflow.js'
import { ScriptedAdapter, achieved, advance, leaf, setup, simulation, task } from './fixtures.js'

test('默认演绎五个最小故事，继续时使用新数量且不重复演绎', async t => {
  const events = Array.from({ length: 7 }, (_, i) => `事件${i + 1}`)
  const { baseOptions, plan } = await setup(t, events)
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
  const { baseOptions, plan } = await setup(t)
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
  const { baseOptions, plan } = await setup(t)
  const start = await runStoryTree({ ...baseOptions, limit: 1, simulate: async () => simulation, adapter: new ScriptedAdapter(leaf('城门')) }, plan.id)
  if (start.kind !== 'paused') throw new Error('预期暂停')
  const options = { ...baseOptions, limit: 1, simulate: async () => { throw new Error('演绎失败') }, adapter: new ScriptedAdapter(leaf('货物')) }
  await assert.rejects(continueStoryTree(options, plan.id, start.batch), /演绎失败/)
  assert.equal((await readdir(baseOptions.collaborationRoot)).filter(file => file.endsWith('.paused.story.json')).length, 1)
  const progress = await inspectStoryProgress(baseOptions, plan.id)
  assert.equal(progress.status, 'needs-review')
  if (progress.status !== 'needs-review') throw new Error('预期已有批次消费但新批次待核查')
  assert.equal(progress.current?.description, '处理货物')
  assert.match(progress.reason, /暂停已消费/)
  await assert.rejects(continueStoryTree(options, plan.id, start.batch), /已使用/)
})

test('继续时校验已保存结果，实际取消的演绎不计入完成', async t => {
  const { baseOptions, plan } = await setup(t)
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
  const stray = join(baseOptions.collaborationRoot, `${plan.id}.${second!.id}.1.setup.scene.json`)
  await writeFile(stray, '{}')
  await assert.rejects(continueStoryTree(options, plan.id, start.batch), /暂停位置之后已有推进记录/)
  assert.equal(adapter.requests.length, 0)
  await rename(stray, join(baseOptions.collaborationRoot, 'stray-setup.bak'))
  await assert.rejects(continueStoryTree(options, plan.id, start.batch, controller.signal), { name: 'AbortError' })
  const files = await readdir(baseOptions.collaborationRoot)
  assert.equal(files.filter(file => file.endsWith('.paused.story.json')).length, 1)
  assert.ok(!files.includes(`${plan.id}.${second!.id}.result.story.json`))
})

test('曲水城暂停核对已结算父故事的场景证据，继续只执行尚未完成的故事', async t => {
  const { baseOptions, plan, eventId } = await setup(t)
  assert.deepEqual(await inspectStoryProgress(baseOptions, plan.id), { status: 'not-started', planId: plan.id })
  const seen: string[] = []
  const sceneIds: string[] = []
  const start = await runStoryTree({
    ...baseOptions, limit: 1, adapter: new ScriptedAdapter([
      advance, task, '{"kind":"split","children":["交涉入城"]}', ...leaf('城门'), achieved, '父故事回报已接收',
    ]),
    simulate: async ({ preparation, recordSceneResult }) => {
      seen.push(preparation)
      const parent = await readStory(baseOptions, plan.id, eventId)
      for (const [index, situation] of ['城门交涉', '城外安置'].entries()) {
        const scene = await createStoryScene(baseOptions, plan.id, parent.children[0]!.id, {
          order: index + 1, situation, preparation: '模拟商队与守卫的安排',
        })
        sceneIds.push(scene.sceneId)
        await recordSceneResult(scene.sceneId, { status: 'completed', simulation })
      }
      return simulation
    },
  }, plan.id)
  if (start.kind !== 'paused') throw new Error('预期根故事暂停')
  assert.equal(start.completedCount, 1)
  const progress = await inspectStoryProgress(baseOptions, plan.id)
  if (progress.status !== 'paused') throw new Error('预期可继续')
  assert.equal(progress.batch, start.batch)
  assert.equal(progress.current.storyId, start.storyId)
  assert.equal(progress.next.description, '处理货物')
  assert.equal(progress.completedCount, 1)
  const confirmed = progress.confirmed.find(({ counted }) => counted)?.result
  assert.deepEqual(confirmed?.formatVersion === 2 && confirmed.sceneIds, sceneIds)

  const original = join(baseOptions.collaborationRoot, `${sceneIds[1]}.result.scene.json`)
  await rename(original, `${original}.bak`)
  const broken = await inspectStoryProgress(baseOptions, plan.id)
  if (broken.status !== 'needs-review') throw new Error('预期场景缺失阻止继续')
  assert.equal(broken.current?.description, '交涉入城')
  assert.deepEqual(broken.scenes?.map(scene => scene.status), ['completed', 'pending'])
  assert.equal(broken.completedCount, 0)
  const adapter = new ScriptedAdapter([...leaf('货物'), achieved])
  const options = {
    ...baseOptions, adapter,
    simulate: async ({ preparation }: { preparation: string }) => { seen.push(preparation); return simulation },
  }
  await assert.rejects(continueStoryTree(options, plan.id, start.batch), /场景尚未结算/)
  assert.equal(adapter.requests.length, 0)
  assert.ok(!(await readdir(baseOptions.collaborationRoot)).some(file => file.endsWith('.continued.story.json')))
  await rename(`${original}.bak`, original)

  const end = await continueStoryTree(options, plan.id, start.batch)
  assert.equal(end.kind, 'result')
  assert.deepEqual(seen, ['城门', '货物'])
  const completed = await inspectStoryProgress(baseOptions, plan.id)
  if (completed.status !== 'completed') throw new Error('预期核查整轮完成')
  assert.equal(completed.completedCount, 2)
  assert.ok(completed.confirmed.some(({ result }) => result.storyId === end.storyId))
})

test('只读核查区分设置后中断与场景结果已写但回报失败', async t => {
  for (const saveResult of [false, true]) {
    const { baseOptions, plan, eventId } = await setup(t)
    const sessionRoot = join(baseOptions.planRoot, '..', 'sessions')
    await mkdir(sessionRoot)
    await writeFile(join(sessionRoot, 'director.jsonl'), '{"role":"assistant","content":"已演绎完成"}\n')
    const options = { ...baseOptions, protectedRoots: [sessionRoot] }
    const adapter = new ScriptedAdapter([...leaf('城门').slice(0, 3), '无效回报'])
    const stopped = new Error('设置后中断')
    await assert.rejects(runStoryTree({
      ...options, adapter,
      simulate: async ({ recordSceneResult }) => {
        const scene = await createStoryScene(options, plan.id, eventId, {
          order: 1, situation: '城门交涉', preparation: '模拟核对身份',
        })
        if (!saveResult) throw stopped
        await recordSceneResult(scene.sceneId, { status: 'completed', simulation })
        return simulation
      },
    }, plan.id), saveResult ? SyntaxError : { message: stopped.message })
    const progress = await inspectStoryProgress(options, plan.id)
    if (progress.status !== 'needs-review') throw new Error('预期进度待核查')
    assert.equal(progress.current?.storyId, eventId)
    assert.equal(progress.batch, undefined)
    assert.equal(progress.completedCount, 0)
    assert.deepEqual(progress.scenes?.map(scene => scene.status), [saveResult ? 'completed' : 'pending'])
    assert.match(progress.reason, saveResult ? /故事回报/ : /场景尚未结算/)
  }
})
