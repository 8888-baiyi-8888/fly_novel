import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { loadConfiguredAdapter } from '../call-llm.js'
import { parseOrganization } from '@fly-novel/organization'
import { parseMapPlace } from '@fly-novel/map'

test('真实主 Agent 委派地图与组织、保存总览并恢复会话', { skip: process.env.FLY_NOVEL_REAL_LLM_TEST !== '1', timeout: 540000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true })
  const resumeRoot = process.env.FLY_NOVEL_INTEGRATION_REAL_RESUME_ROOT
  const root = resumeRoot ? await realpath(resumeRoot) : await realpath(await mkdtemp(join(tmp, 'world-integration-real-'))); t.diagnostic(`隔离测试目录：${root}`)
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  if (!resumeRoot) {
    for (const name of ['main', 'confirmed', 'catalog', 'map/places', 'map/connections', 'organization/organizations', 'organization/relations', 'organization/memberships']) await mkdir(join(readRoot, name), { recursive: true })
    await mkdir(sessionRoot)
  }
  const world = { worldId: 'integration-real', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') },
    agents: [{ agentId: 'map', writableRoot: join(readRoot, 'map') }, { agentId: 'organization', writableRoot: join(readRoot, 'organization') }] }
  if (!resumeRoot) await initializeCatalog(world.catalogRoot, world.worldId)
  const sessionExists = async (prefix: string, agentId: string, sessionId: string) => {
    const id = `${prefix}-${createHash('sha256').update(JSON.stringify([world.worldId, agentId, sessionId])).digest('hex')}`
    try { await access(join(sessionRoot, `s-${Buffer.from(id, 'utf8').toString('base64url')}`, 'session.v2.jsonl')); return true }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error }
  }
  if (resumeRoot && !await sessionExists('world-initialization', 'main', 'main')) throw new Error('恢复目录中缺少主 Agent 的原会话')
  const model = await loadConfiguredAdapter('deepseek')
  const child = { sessionRoot, sessionMode: 'create' as const, ...model, maxSteps: 20 }
  const mainSession = { sessionRoot, sessionId: 'main', sessionMode: resumeRoot ? 'resume' as const : 'create' as const }
  const deployment = { singleWriterProcess: true as const, mainMaxSteps: 30, catalog: {}, mainSession,
    mapAgent: { ...child, agentId: 'map', sessionId: 'map', sessionMode: resumeRoot && await sessionExists('map-agent', 'map', 'map') ? 'resume' as const : 'create' as const },
    organizationAgent: { ...child, agentId: 'organization', sessionId: 'organization', sessionMode: resumeRoot && await sessionExists('organization-agent', 'organization', 'organization') ? 'resume' as const : 'create' as const } }
  let resumePrompt = '继续。先核实已经保存的地图、组织、目录和总览；保留已有成果，不要重复创建，补做原任务中未完成部分并报告实际结果。'
  if (resumeRoot) {
    const placeRoot = join(readRoot, 'map', 'places')
    const placeFiles = (await readdir(placeRoot)).filter(name => name.endsWith('.json'))
    const places = await Promise.all(placeFiles.map(async file => parseMapPlace(await readFile(join(placeRoot, file), 'utf8'))))
    const city = places.find(place => place.name === '曲水城')
    const orgCount = (await readdir(join(readRoot, 'organization', 'organizations'))).filter(name => name.endsWith('.json')).length
    const plans = (await readdir(world.mainAgent.writableRoot)).filter(name => name.startsWith('world-plan-') && name.endsWith('.md')).length
    resumePrompt += ` 已核实：地图已有 ${places.length} 个地点${city ? `，曲水城 ID 为 ${city.id}` : ''}；组织 ${orgCount} 个，第一版总览 ${plans} 个。`
    if (city) resumePrompt += ' 保留现有地图，不再开发或重复创建地点；核对必要正文后继续未完成的组织与总览。可能超出近期范围的地点保留并在报告中说明，不删除已有成果。'
  }
  const first = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, deployment)
  const firstTimeout = setTimeout(() => first.cancel(), 240000)
  try {
    const response = await first.run({ prompt: resumeRoot ? resumePrompt : '构想已经确认：这是资源有限的河谷城邦世界，近期只规划一座曲水城及其议会，外海留白。请按需委派地图 Agent 创建世界地图和曲水城，再委派组织 Agent 创建青河议会并引用真实曲水城 ID；读取实际成果后整合完整待审第一版，调用 save_first_world_plan 保存总览并报告路径。' })
    assert.ok(response.content.trim())
  } finally { clearTimeout(firstTimeout); await first.dispose() }
  const files = (await readdir(world.mainAgent.writableRoot)).filter(name => name.startsWith('world-plan-') && name.endsWith('.md'))
  assert.ok(files.length, '真实主 Agent 未保存第一版总览')
  const placeFiles = (await readdir(join(readRoot, 'map', 'places'))).filter(name => name.endsWith('.json'))
  assert.ok(placeFiles.length, '地图 Agent 未保存地点')
  const orgRoot = join(readRoot, 'organization', 'organizations'); const orgFiles = (await readdir(orgRoot)).filter(name => name.endsWith('.json'))
  assert.ok(orgFiles.length, '组织 Agent 未保存组织')
  const organizations = await Promise.all(orgFiles.map(async file => parseOrganization(await readFile(join(orgRoot, file), 'utf8'))))
  assert.ok(organizations.some(org => org.locations.some(location => location.place.kind === 'linked' && placeFiles.includes(`${location.place.id}.json`))), '组织未关联实际地点')
  const before = await Promise.all(files.map(file => readFile(join(world.mainAgent.writableRoot, file), 'utf8')))
  const resumed = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { ...deployment,
    mainSession: { ...mainSession, sessionMode: 'resume' }, mapAgent: { ...deployment.mapAgent, sessionMode: 'resume' }, organizationAgent: { ...deployment.organizationAgent, sessionMode: 'resume' } })
  const resumeTimeout = setTimeout(() => resumed.cancel(), 180000)
  try {
    const response = await resumed.run({ prompt: '继续：先读取已经保存的第一版总览和实际成果，报告目前的地图、组织和外海留白；不要创建或改写任何文件。' })
    assert.ok(response.content.trim())
  } finally { clearTimeout(resumeTimeout); await resumed.dispose() }
  const afterFiles = (await readdir(world.mainAgent.writableRoot)).filter(name => name.startsWith('world-plan-') && name.endsWith('.md'))
  assert.deepEqual(afterFiles.sort(), files.sort())
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(world.mainAgent.writableRoot, file), 'utf8'))), before)
  t.diagnostic(`保留 ${files.length} 份第一版总览；真实模型内容需要人工审阅`)
})
