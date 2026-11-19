import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ToolCallId } from '@fly-novel/llm'
import { parseOrganization } from '@fly-novel/organization'
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { loadConfiguredAdapter } from '../call-llm.js'

test('真实地图与组织 Agent 共享存储并引用地点', { skip: process.env.FLY_NOVEL_REAL_LLM_TEST !== '1', timeout: 240000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true })
  const root = await realpath(await mkdtemp(join(tmp, 'shared-storage-real-'))); t.diagnostic(`隔离测试目录：${root}`)
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const name of ['main', 'confirmed', 'catalog', 'map/places', 'map/connections', 'organization/organizations', 'organization/relations', 'organization/memberships']) await mkdir(join(readRoot, name), { recursive: true })
  await mkdir(sessionRoot)
  const world = { worldId: 'shared-real', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'map', writableRoot: join(readRoot, 'map') }, { agentId: 'organization', writableRoot: join(readRoot, 'organization') }] }
  const model = await loadConfiguredAdapter('deepseek')
  const common = { sessionRoot, sessionMode: 'create' as const, ...model }
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true,
    mapAgent: { ...common, agentId: 'map', sessionId: 'map' }, organizationAgent: { ...common, agentId: 'organization', sessionId: 'organization' } })
  try {
    const delegate = async (name: string, task: string) => (await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: name as ToolCallId, name, arguments: JSON.stringify({ task }) }],
      workingDirectory: readRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal })).results[0].result
    const mapResult = await delegate('delegate_map', '请创建世界地图概览和一个名为曲水城的地点，实际调用工具保存，其他地区留白。')
    assert.equal(mapResult.isError, false, JSON.stringify(mapResult))
    const [file] = (await readdir(join(readRoot, 'map', 'places'))).filter(name => name.endsWith('.json')); assert.ok(file, '地图 Agent 未保存地点')
    const placeId = file.replace(/\.json$/, '')
    const orgResult = await delegate('delegate_organization', `请创建青河议会组织，地点使用已存在的地点 ID ${placeId} 建立关联；先核验地点，实际保存组织并报告结果。`)
    assert.equal(orgResult.isError, false, JSON.stringify(orgResult))
    const files = (await readdir(join(readRoot, 'organization', 'organizations'))).filter(name => name.endsWith('.json'))
    const organizations = await Promise.all(files.map(async name => parseOrganization(await readFile(join(readRoot, 'organization', 'organizations', name), 'utf8'))))
    assert.ok(organizations.some(org => org.locations.some(location => location.place.kind === 'linked' && location.place.id === placeId)), '组织未关联实际地点')
    t.diagnostic(`保存地点 ${placeId}，组织 ${organizations.length} 个；内容仍需人工审阅`)
  } finally { await parent.dispose() }
})
