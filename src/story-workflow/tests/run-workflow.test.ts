import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { FsVersion } from '@fly-novel/fs'
import { CharacterStore } from '@fly-novel/character'
import { openStoryRunWorkflow, type StoryRunWorkflowOptions } from '../../app/story-run-workflow.js'
import { achieved, advance, createTestDirectory, ScriptedAdapter, task, report } from './fixtures.js'

async function fixture(t: TestContext, responses: string[] = ['{"kind":"planned","events":["北门交涉"]}']) {
  const root = await createTestDirectory(t, 'story-run-')
  const planRoot = join(root, 'plans')
  const collaborationRoot = join(root, 'stories')
  const runRoot = join(root, 'runs')
  const readRoot = join(root, 'world')
  await Promise.all([planRoot, collaborationRoot, runRoot, readRoot].map(path => mkdir(path)))
  const deliveryId = randomUUID()
  const worldId = '曲水城'
  const target = { kind: 'file' as const, ownerAgentId: 'main', path: 'main/city.md' }
  const content = '夜间闭门'
  const adapter = new ScriptedAdapter(responses)
  const selection = { task: '安置商队', delivery: [{ target, category: 'setting' as const }] }
  const binding: StoryRunWorkflowOptions['binding'] = {
    deliveryId,
    world: { worldId, readRoot, confirmedRoot: readRoot, catalogRoot: readRoot,
      mainAgent: { agentId: 'main', writableRoot: readRoot }, agents: [] },
    async readDelivery() {
      return { worldId, deliveryId, version: FsVersion('1'), formatVersion: 1, reviewVersion: '1', notes: [], uncovered: [], deferred: [], acknowledgedUncovered: [],
        artifacts: [{ target, content, version: '1', digest: createHash('sha256').update(content).digest('hex') }] }
    },
  }
  return { options: { planRoot, collaborationRoot, runRoot, protectedRoots: [], binding, configurationVersion: 'fixture-1',
    director: { provider: 'fixture', model: 'fixture', adapter } }, selection, adapter, runId: randomUUID() }
}

test('开始请求固定规划身份，重开后重读，版本和请求冲突分别拒绝', async t => {
  const { options, selection, adapter, runId } = await fixture(t)
  const first = await openStoryRunWorkflow(options)
  try {
    await assert.rejects(openStoryRunWorkflow(options), /已有可信写入者/)
    const [plan, same] = await Promise.all([first.start(runId, selection), first.start(runId, selection)])
    assert.deepEqual(same, plan)
    assert.equal(adapter.requests.length, 1)
    assert.equal((await first.read(runId))?.manifest.planId, plan.id)
    const view = await first.diagnose(runId)
    assert.equal(view.status, 'ready')
    assert.deepEqual(await first.diagnose(runId), view)
    await assert.rejects(first.start(runId, { ...selection, task: '另外一轮' }), /不同开始请求/)
  } finally { await first.close() }
  const reopened = await openStoryRunWorkflow(options)
  try { assert.equal((await reopened.start(runId, selection)).outcome.kind, 'planned') }
  finally { await reopened.close() }
  assert.equal(adapter.requests.length, 1)
  const changed = await openStoryRunWorkflow({ ...options, configurationVersion: 'fixture-2' })
  try {
    await assert.rejects(changed.read(runId), /配置已变化/)
    assert.equal((await changed.diagnose(runId)).issue, 'stale')
  }
  finally { await changed.close() }
  const path = join(options.runRoot, `${runId}.manifest.run.json`)
  const saved = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...saved, formatVersion: 999 }))
  const corrupted = await openStoryRunWorkflow(options)
  try {
    await assert.rejects(corrupted.read(runId))
    assert.equal((await corrupted.diagnose(runId)).issue, 'corrupt')
  }
  finally { await corrupted.close() }
})

async function characterOptions(t: TestContext, data: Awaited<ReturnType<typeof fixture>>) {
  const world = data.options.binding.world
  const path = join(world.readRoot, 'characters')
  await mkdir(path)
  const store = await CharacterStore.open(path, true)
  t.after(() => store.close())
  const { id: characterId } = await store.create({ name: '守卫', summary: '值守城门', categories: {}, body: '夜间守卫' })
  const candidate = { characterId, version: (await store.readVersioned(characterId)).version, presence: '城门值守' }
  const role = new ScriptedAdapter(['{"kind":"respond","speech":[{"text":"城门已经关闭","channel":"normal","intendedCharacterIds":[]}],"actions":[]}'])
  const config: NonNullable<StoryRunWorkflowOptions['execution']> = {
    review: { policy: { kind: 'indefinite' } },
    scene: { maxEvents: 5, characters: { store, ownerAgentId: 'characters',
      configure: () => ({ provider: 'fixture', model: 'fixture', adapter: role, version: '1', timeoutMs: 5000 }) },
      async prepare() {
        return { candidates: [candidate], initialCandidates: [characterId],
          async grants(_, scene) {
            return [{ characterId, sceneId: scene.sceneId, category: 'profile', content: '夜间守卫', basis: '档案', source: { kind: 'profile' } },
              { characterId, sceneId: scene.sceneId, category: 'observation', content: scene.situation, basis: '当前场景', source: { kind: 'scene', field: 'situation' } }]
          },
          async conditions() { return { version: '1', participants: [{ characterId, position: '北门', hearing: 'clear', sight: 'clear', basis: '在场' }] } },
          allowObservation: () => true,
        }
      },
    },
  }
  return { role, characterId, options: { ...data.options, execution: config, binding: { ...data.options.binding,
    world: { ...world, agents: [{ agentId: 'characters', writableRoot: store.rootDirectory }] } } } }
}

test('正式入口从交付经用户审阅和真实角色编排到根回报', async t => {
  const responses = ['{"kind":"planned","events":["北门交涉"]}']
  const data = await fixture(t, responses)
  const { options, characterId, role } = await characterOptions(t, data)
  responses.push(advance, task, '{"kind":"direct","preparation":"核对闭门"}',
    JSON.stringify({ participants: [{ characterId, invitation: '回答商队' }] }),
    JSON.stringify({ perceptions: [{ characterId, status: 'not-received', reason: '本人发言', observations: [] }], next: { kind: 'end', reason: '交涉结束' } }),
    report, '已接收', achieved)
  const first = await openStoryRunWorkflow(options)
  const { runId, selection } = data
  try {
    await first.start(runId, selection)
    const paused = await first.advance(runId, (await first.diagnose(runId)).version)
    assert.equal(paused.status, 'awaiting-review')
    assert.equal(role.requests.length, 0)
  } finally { await first.close() }
  const next = await openStoryRunWorkflow(options)
  try {
    const paused = await next.diagnose(runId)
    assert.equal(paused.status, 'awaiting-review')
    await next.submitReview(runId, paused.batch!, paused.review, { kind: 'select', optionId: 'original' })
    const confirmed = await next.diagnose(runId)
    assert.equal(confirmed.status, 'review-ready')
    const result = await next.advance(runId, confirmed.version)
    assert.equal(result.status, 'completed')
    assert.equal(role.requests.length, 1)
    await assert.rejects(next.advance(runId, confirmed.version), /诊断版本已变化/)
  } finally { await next.close() }
})

test('从已有角色响应和已保存导演回报继续，只补做缺失步骤并建立下一轮', async t => {
  const responses = ['{"kind":"planned","events":["北门交涉"]}']
  const data = await fixture(t, responses)
  const { options, characterId, role } = await characterOptions(t, data)
  const scene = options.execution.scene
  let interrupt = true
  const settings = { ...options, execution: { ...options.execution, review: undefined, scene: {
    ...scene,
    async prepare(input: Parameters<typeof scene.prepare>[0]) {
      const prepared = await scene.prepare(input)
      return { ...prepared, async conditions(...args: Parameters<typeof prepared.conditions>) {
        if (interrupt) { interrupt = false; throw new Error('角色响应保存后中断') }
        return prepared.conditions(...args)
      } }
    },
  } } }
  responses.push(advance, task, '{"kind":"direct","preparation":"核对闭门"}',
    JSON.stringify({ participants: [{ characterId, invitation: '回答商队' }] }))
  const { runId, selection } = data
  const first = await openStoryRunWorkflow(settings)
  try {
    await first.start(runId, selection)
    await assert.rejects(first.startNext(runId, randomUUID(), selection), /尚未形成/)
    await assert.rejects(first.advance(runId, (await first.diagnose(runId)).version), /响应保存后中断/)
    const view = await first.diagnose(runId)
    assert.equal(view.status, 'needs-review')
    assert.equal(view.scenes[0]?.participation[0]?.status, 'responded')
    assert.equal(view.scenes[0]?.sequence, 0)
  } finally { await first.close() }
  const second = await openStoryRunWorkflow(settings)
  responses.push(JSON.stringify({ perceptions: [{ characterId, status: 'not-received', reason: '本人发言', observations: [] }], next: { kind: 'end', reason: '结束' } }), report)
  try {
    await assert.rejects(second.advance(runId, (await second.diagnose(runId)).version), /缺少测试响应/)
    assert.equal(role.requests.length, 1)
    const view = await second.diagnose(runId)
    assert.equal(view.status, 'needs-review')
    assert.equal(view.scenes[0]?.status, 'completed')
  } finally { await second.close() }
  const third = await openStoryRunWorkflow(settings)
  try {
    const calls = data.adapter.requests.length
    responses.push('原回报已接收', achieved, '{"kind":"planned","events":["天亮后再议"]}')
    const finished = await third.advance(runId, (await third.diagnose(runId)).version)
    assert.equal(finished.status, 'completed')
    assert.equal(data.adapter.requests.length - calls, 2)
    assert.equal(role.requests.length, 1)
    const successor = randomUUID()
    const nextInput = { ...selection, task: '天亮后核对入城条件' }
    const next = await third.startNext(runId, successor, nextInput)
    assert.equal((await third.read(successor))?.manifest.previous?.runId, runId)
    assert.notEqual(next.id, finished.planId)
    assert.deepEqual(await third.startNext(runId, successor, nextInput), next)
  } finally { await third.close() }
})

test('曲水城正式样例跨进程保留审阅、角色响应和已应用状态', { timeout: 30000 }, async t => {
  const entry = join(__dirname, '../../app/story-run-example.js')
  function subprocess(args: string[], code = 0) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 })
    if (result.error) throw result.error
    assert.equal(result.status, code, result.stderr || result.stdout)
    return result.stdout
  }
  const opened = JSON.parse(subprocess([entry]))
  const root = String(opened.root)
  t.after(async () => {
    assert.equal(dirname(root), await realpath(resolve('tmp')))
    assert.equal(await realpath(root), root)
    await rm(root, { recursive: true, force: true })
  })
  assert.equal(opened.status, 'awaiting-review')
  assert.equal(JSON.parse(subprocess([entry, root, 'inspect'])).review.reviewId, opened.review.reviewId)
  assert.equal(JSON.parse(subprocess([entry, root, 'approve'])).status, 'review-ready')
  const exitOn = async (method: 'writeFile' | 'link', argument: number, suffix: string, code: number) => {
    const hook = join(root, `fixture-${code}.cjs`)
    await writeFile(hook, `const fs = require('node:fs/promises')
const original = fs.${method}
fs.${method} = async (...args) => {
  const result = await original(...args)
  if (String(args[${argument}]).endsWith(${JSON.stringify(suffix)})) process.exit(${code})
  return result
}
`, { flag: 'wx' })
    subprocess(['--require', hook, entry, root, 'advance'], code)
  }
  await exitOn('writeFile', 0, '.character-result.json', 71)
  const interrupted = JSON.parse(subprocess([entry, root, 'inspect']))
  assert.equal(interrupted.status, 'needs-review')
  assert.equal(interrupted.scenes[0]?.participation[0]?.status, 'responded')
  const stories = join(root, 'stories')
  const participation = (await readdir(stories)).filter(name => name.endsWith('.character-result.json'))
  assert.equal(participation.length, 1)
  await exitOn('link', 1, 'convoy-1.json', 72)
  const stateRoot = join(root, 'state')
  const recordedState = await readFile(join(stateRoot, 'convoy-1.json'), 'utf8')
  const recovered = JSON.parse(subprocess([entry, root, 'advance']))
  assert.equal(recovered.status, 'completed')
  assert.equal(recovered.completed.result.worldEvidence.current.revision, 1)
  assert.deepEqual((await readdir(stories)).filter(name => name.endsWith('.character-result.json')), participation)
  assert.equal((await readdir(stories)).filter(name => name.endsWith('.adopted-event.json')).length, 1)
  assert.equal((await readdir(stateRoot)).filter(name => name.startsWith('operation-')).length, 1)
  assert.equal(await readFile(join(stateRoot, 'convoy-1.json'), 'utf8'), recordedState)
  const successor = JSON.parse(subprocess([entry, root, 'next']))
  assert.equal(successor.status, 'ready')
  assert.notEqual(successor.planId, opened.planId)
})
