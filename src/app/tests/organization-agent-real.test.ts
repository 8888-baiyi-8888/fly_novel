import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseOrganization, parseOrganizationMembership, parseOrganizationRelation } from '@fly-novel/organization'
import { createOrganizationAgent } from '../agents/organization-agent.js'
import { loadConfiguredAdapter } from '../call-llm.js'

test('真实模型依据世界背景创建组织、关系和未关联成员', { skip: process.env.FLY_NOVEL_REAL_LLM_TEST !== '1', timeout: 180000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true })
  const root = await realpath(await mkdtemp(join(tmp, 'organization-real-'))); t.diagnostic(`独立测试目录：${root}`)
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const name of ['main', 'organization/organizations', 'organization/relations', 'organization/memberships', 'confirmed', 'catalog']) await mkdir(join(readRoot, name), { recursive: true })
  await mkdir(sessionRoot)
  const world = { worldId: 'organization-real', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'organization', writableRoot: join(readRoot, 'organization') }] }
  await writeFile(join(world.confirmedRoot, 'background.md'), '青河城邦群水源紧缺，曲水城依靠共同水渠，远方海域由用户留白。\n', 'utf8')
  const model = await loadConfiguredAdapter('deepseek')
  const agent = await createOrganizationAgent({ workspaces: [world], worldId: world.worldId, agentId: 'organization', sessionId: 'real', sessionRoot, sessionMode: 'create', ...model, singleWriterProcess: true })
  try {
    const response = await agent.run({ prompt: '请先读取 confirmed/background.md 的世界背景。为近期故事实际保存两个组织：曲水议会和河谷商盟，建立它们因水渠合作的一条双向关系；为曲水议会保存一条未建档人物“水渠联络人”的未关联成员线索，职务未知。不要把海域当作组织留白。最后说明引用的背景来源、写入成果和未覆盖内容。' })
    const load = async (folder: string) => Promise.all((await readdir(join(readRoot, 'organization', folder))).filter(name => name.endsWith('.json')).map(name => readFile(join(readRoot, 'organization', folder, name), 'utf8')))
    const organizations = (await load('organizations')).map(parseOrganization); const relations = (await load('relations')).map(parseOrganizationRelation); const members = (await load('memberships')).map(parseOrganizationMembership)
    const council = organizations.find(item => item.name === '曲水议会'); const alliance = organizations.find(item => item.name === '河谷商盟')
    assert.ok(council && alliance, '未创建两个指定组织')
    assert.ok(organizations.every(item => item.reviewStatus === 'suggested' && item.reserved.length === 0), '审核状态或组织留白不符合要求')
    assert.ok(relations.some(item => item.kind === 'general' && item.direction === 'two-way' && [item.fromId, item.toId].includes(council.id) && [item.fromId, item.toId].includes(alliance.id)), '缺少指定组织间的双向关系')
    assert.ok(members.some(item => item.organizationId === council.id && item.person.kind === 'unresolved' && item.person.description.includes('联络人')), '缺少未关联成员线索')
    assert.match(response.content, /background\.md|世界背景/, '回复未说明背景来源')
    t.diagnostic(`组织 ${organizations.length}，关系 ${relations.length}，成员 ${members.length}；模型回复 ${response.content.length} 字`)
  } finally { await agent.dispose() }
})
