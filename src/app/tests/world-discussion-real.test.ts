import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore, parseMapPlace } from '@fly-novel/map'
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { DiscussionService } from '../../world-init/discussion/service.js'
import { createInitialDiscussionAdapter } from '../../world-init/discussion/initial-adapters.js'

test('真实模型围绕已有地点进行两轮待审修改', { skip: process.env.FLY_NOVEL_REAL_LLM_TEST !== '1', timeout: 360000 }, async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'discussion-real-'))); t.diagnostic(`隔离测试目录：${root}`)
  for (const dir of ['world/main', 'world/confirmed', 'world/catalog', 'world/map/places', 'world/map/connections', 'pending/discussions', 'pending/candidates', 'sessions']) await mkdir(join(root, dir), { recursive: true })
  const view = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  const world = { worldId: 'discussion-real', readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [{ agentId: 'map', writableRoot: join(view, 'map') }] }
  const context = new Context(); const backend = context.plugin(LocalFileSystem, { cwd: root }); await backend
  const map = await MapStore.open({ fs: context.fs, root: join(view, 'map'), worldId: world.worldId, access: 'read-write', singleWriterProcess: true })
  await map.createOverview({ name: '河谷', description: '', scale: { width: 100, height: 100, unit: 'km' }, layers: [{ id: 'area', name: '地区' }], orientation: '北', reserved: [] })
  const place = await map.createPlace({ name: '曲水城', aliases: [], description: '城门昼夜开放。', detailLevel: 'overview',
    parents: [{ layerId: 'area', parent: { kind: 'world' }, localBoxes: [[0, 0, 100, 100]], frameBox: null, coverage: 'complete' }], reserved: [] })
  const service = await DiscussionService.open({ worldId: world.worldId, root: join(root, 'pending'), worldRoots: [view], fs: context.fs,
    adapter: createInitialDiscussionAdapter(world, { map: { agentId: 'map', store: map } }), singleWriterProcess: true })
  const discussion = await service.createDiscussion({ kind: 'place', id: place.id }, 'city')
  const agent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, {
    singleWriterProcess: true, mainMaxSteps: 20, discussion: { firstVersionComplete: true, binding: { service, discussionId: discussion.id } },
    mainSession: { sessionRoot, sessionId: 'city', sessionMode: 'create' },
  })
  const timeout = setTimeout(() => agent.cancel(), 240000)
  try {
    const first = await agent.run({ prompt: '请读取已选曲水城的完整资料，把城门规则改为夜间关闭，并调用 discussion_prepare 保存完整 JSON 待审候选；保留全部未修改字段。不要修改当前资料。' })
    assert.ok(first.content.trim())
    const saved = await service.listCandidates(discussion.id)
    assert.equal(saved.length, 1, '模型没有保存第一轮候选')
    assert.match(parseMapPlace(saved[0]!.value.content).description, /关闭/)
    const second = await agent.run({ prompt: '继续修改同一候选：允许商队夜间通行。请先读取现有候选和版本，再以完整 JSON 更新候选，保留未修改字段。' })
    assert.ok(second.content.trim())
    const after = (await service.listCandidates(discussion.id))[0]!
    assert.notEqual(after.version, saved[0]!.version, '模型没有更新候选')
    const candidate = parseMapPlace(after.value.content)
    assert.match(candidate.description, /商队/); assert.match(candidate.description, /关闭/)
    const current = (await map.readPlace(place.id)).document
    assert.equal(current.description, '城门昼夜开放。')
    assert.deepEqual({ ...candidate, description: current.description }, current)
    t.diagnostic('两轮候选已保存，当前地点未改写；候选内容仍需人工审阅。')
  } finally { clearTimeout(timeout); await agent.dispose(); await service.close(); await map.close(); await backend.dispose() }
})
