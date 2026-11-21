import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { MapStore, formatMapDocument } from '@fly-novel/map'
import { CharacterStore, formatCharacterDocument } from '@fly-novel/character'
import { OrganizationStore, formatOrganizationDocument } from '@fly-novel/organization'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { DiscussionService } from '../../world-init/discussion/service.js'
import { createInitialDiscussionAdapter } from '../../world-init/discussion/initial-adapters.js'

class IntegrationAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly contents: string[]) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      const calls = this.contents.map((content, index) => ({ id: `candidate-${index}`, name: 'discussion_prepare', args: { targetIndex: index, content, summary: '局部修改' } }))
      calls.push({ id: 'direct-write', name: 'write', args: { targetIndex: 0, content: '覆盖', summary: '越权' } })
      calls.push({ id: 'direct-member', name: 'organization_membership_update', args: { targetIndex: 0, content: '覆盖', summary: '越权' } })
      for (const [index, call] of calls.entries()) yield { type: 'block-end', index,
        block: { type: 'tool-call', id: call.id as ToolCallId, name: call.name, arguments: JSON.stringify(call.args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '逐项报告候选结果' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('双世界地点、人物与成员候选独立保存并拒绝直接写入', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'discussion-two-worlds-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions'); await mkdir(sessions)
  const fixtures = []
  for (const name of ['a', 'b']) {
    const view = join(root, name); const pending = join(root, `pending-${name}`)
    for (const dir of ['main', 'confirmed', 'catalog', 'map/places', 'map/connections', 'characters', 'organization/organizations', 'organization/relations', 'organization/memberships']) await mkdir(join(view, dir), { recursive: true })
    for (const dir of ['discussions', 'candidates']) await mkdir(join(pending, dir), { recursive: true })
    const world = { worldId: name, readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'),
      mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [{ agentId: 'map', writableRoot: join(view, 'map') },
        { agentId: 'person', writableRoot: join(view, 'characters') }, { agentId: 'organization', writableRoot: join(view, 'organization') }] }
    const context = new Context(); const backend = context.plugin(LocalFileSystem, { cwd: root }); await backend
    const map = await MapStore.open({ fs: context.fs, root: join(view, 'map'), worldId: name, access: 'read-write', singleWriterProcess: true })
    await map.createOverview({ name: '河谷', description: '', scale: { width: 100, height: 100, unit: 'km' }, layers: [{ id: 'area', name: '地区' }], orientation: '北', reserved: [] })
    const place = await map.createPlace({ name: '曲水城', aliases: [], description: '原城门', detailLevel: 'overview', parents: [{ layerId: 'area', parent: { kind: 'world' }, localBoxes: [[0, 0, 100, 100]], frameBox: null, coverage: 'complete' }], reserved: [] })
    const characters = await CharacterStore.open(join(view, 'characters'), true)
    const person = await characters.create({ name: '林岚', summary: '', categories: {}, body: '原人物' })
    const organization = await OrganizationStore.open({ fs: context.fs, root: join(view, 'organization'), worldId: name, access: 'read-write', phase: 'initialization', singleWriterProcess: true,
      resolvePerson: async id => id === person.id ? { id, worldId: name } : null })
    const sect = await organization.createOrganization({ name: '青云宗', aliases: [], organizationType: null, detailLevel: 'overview', minLevel: 0, sections: [], locations: [], reserved: [] })
    const member = await organization.createMembership({ organizationId: sect.id, person: { kind: 'linked', id: person.id }, roles: ['长老'], period: null, description: '', minLevel: 0 })
    const adapter = createInitialDiscussionAdapter(world, { map: { agentId: 'map', store: map }, characters: { agentId: 'person', store: characters }, organization: { agentId: 'organization', store: organization } })
    const service = await DiscussionService.open({ worldId: name, root: pending, worldRoots: [view], fs: context.fs, adapter, singleWriterProcess: true })
    const target = { kind: 'place' as const, id: place.id }; const discussion = await service.createDiscussion(target, `session-${name}`)
    const placeDoc = (await map.readPlace(place.id)).document; const personDoc = await characters.read(person.id); const memberDoc = (await organization.readMembership(member.id)).document
    const contents = [formatMapDocument({ ...placeDoc, description: `候选-${name}` }),
      formatCharacterDocument({ ...personDoc, metadata: { ...personDoc.metadata, contentStatus: 'pending' }, body: `候选人物-${name}` }),
      formatOrganizationDocument({ ...memberDoc, roles: [`候选职务-${name}`] })]
    fixtures.push({ world, backend, map, characters, organization, service, discussion, place, person, member, contents })
  }
  try {
    const worlds = fixtures.map(item => item.world)
    const a = fixtures[0]!; const b = fixtures[1]!
    await assert.rejects(a.service.readRelated(a.discussion.id, { kind: 'place', id: b.place.id }), /地点不存在/)
    await assert.rejects(createWorldInitializationAgentWithWorldWorkspaces(worlds, a.world.worldId, undefined, { singleWriterProcess: true,
      discussion: { firstVersionComplete: true, binding: { service: b.service, discussionId: b.discussion.id } },
      mainSession: { sessionRoot: sessions, sessionId: 'session-b', sessionMode: 'create' } }), /讨论服务与世界不匹配/)
    for (const item of fixtures) {
      const adapter = new IntegrationAdapter(item.contents)
      const mock = t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter }))
      const agent = await createWorldInitializationAgentWithWorldWorkspaces(worlds, item.world.worldId, undefined, { singleWriterProcess: true,
        discussion: { firstVersionComplete: true, binding: { service: item.service, discussionId: item.discussion.id, additionalTargets: [
          { kind: 'character', id: item.person.id }, { kind: 'organization-membership', id: item.member.id }] } },
        mainSession: { sessionRoot: sessions, sessionId: `session-${item.world.worldId}`, sessionMode: 'create' } })
      try {
        await agent.run({ prompt: '分别准备地点、人物和成员的候选' })
        const results = adapter.requests[1]!.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
        for (const id of ['candidate-0', 'candidate-1', 'candidate-2']) assert.ok(results.some(item => item.type === 'tool-result' && item.toolCallId === id && !item.isError), id)
        for (const id of ['direct-write', 'direct-member']) assert.ok(results.some(item => item.type === 'tool-result' && item.toolCallId === id && item.isError), id)
        assert.equal((await item.service.listCandidates(item.discussion.id)).length, 3)
        assert.equal((await item.map.readPlace(item.place.id)).document.description, '原城门')
        assert.equal((await item.characters.read(item.person.id)).body, '原人物\n')
        assert.deepEqual((await item.organization.readMembership(item.member.id)).document.roles, ['长老'])
      } finally { await agent.dispose(); mock.mock.restore() }
    }
    assert.notEqual((await a.service.listCandidates(a.discussion.id))[0]!.value.worldId, (await b.service.listCandidates(b.discussion.id))[0]!.value.worldId)
  } finally {
    for (const item of fixtures) { await item.service.close(); await item.organization.close(); await item.characters.close(); await item.map.close(); await item.backend.dispose() }
  }
})
