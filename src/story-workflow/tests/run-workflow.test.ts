import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { FsVersion } from '@fly-novel/fs'
import { openStoryRunWorkflow, type StoryRunWorkflowOptions } from '../../app/story-run-workflow.js'
import { createTestDirectory, ScriptedAdapter } from './fixtures.js'

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
    await assert.rejects(first.start(runId, { ...selection, task: '另外一轮' }), /不同开始请求/)
  } finally { await first.close() }
  const reopened = await openStoryRunWorkflow(options)
  try { assert.equal((await reopened.start(runId, selection)).outcome.kind, 'planned') }
  finally { await reopened.close() }
  assert.equal(adapter.requests.length, 1)
  const changed = await openStoryRunWorkflow({ ...options, configurationVersion: 'fixture-2' })
  try { await assert.rejects(changed.read(runId), /配置已变化/) }
  finally { await changed.close() }
  const path = join(options.runRoot, `${runId}.manifest.run.json`)
  const saved = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...saved, formatVersion: 999 }))
  const corrupted = await openStoryRunWorkflow(options)
  try { await assert.rejects(corrupted.read(runId)) }
  finally { await corrupted.close() }
})
