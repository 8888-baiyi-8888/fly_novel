import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'

type Job = { name: string; args: object }
function result(options: GenerateOptions, id: string): Record<string, unknown> {
  const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === id)
  assert.ok(block && block.type === 'tool-result' && !block.isError, `${id}: ${JSON.stringify(block)}`)
  const text = block.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text')
  const parsed: unknown = JSON.parse(text.text); assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
  return Object.fromEntries(Object.entries(parsed))
}
function call(id: string, name: string, args: object): StreamChunk {
  return { type: 'block-end', index: 0, block: { type: 'tool-call', id: id as ToolCallId, name, arguments: JSON.stringify(args) } }
}

test('两个世界联合装配八类 Agent，读取成果并保存待审总览', { timeout: 60000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true })
  const root = await realpath(await mkdtemp(join(tmp, 'world-modules-'))); t.after(() => rm(root, { recursive: true, force: true }))
  for (const city of [false, true]) {
    const worldId = city ? 'city' : 'cultivation'; const readRoot = join(root, worldId); const sessionRoot = join(root, `${worldId}-sessions`)
    const dirs = ['main', 'confirmed', 'catalog', 'basics', 'characters', 'map/places', 'map/connections', 'organization/organizations', 'organization/relations', 'organization/memberships',
      'history/events', 'history/candidates', 'situation/overviews', 'situation/situations', 'situation/candidates', 'specific/topics', 'specific/items', 'specific/candidates',
      ...['macro-development/blueprints', 'macro-development/directions', 'macro-development/proposals', 'storylines/stories', 'storylines/growth-lines', 'character-growth/blueprints', 'character-growth/items', 'candidates'].map(name => `development/${name}`)]
    for (const dir of dirs) await mkdir(join(readRoot, dir), { recursive: true })
    await mkdir(sessionRoot)
    const owners = ['basics', 'characters', 'map', 'organization', 'history', 'situation', 'development', 'specific']
    const world = { worldId, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
      mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: owners.map(agentId => ({ agentId, writableRoot: join(readRoot, agentId) })) }
    await initializeCatalog(world.catalogRoot, world.worldId)
    const paths: Record<string, string> = {}; const ids: Record<string, string> = {}
    const point = city ? '曲水城' : '青云山'; const group = city ? '青河议会' : '青云宗'
    const development = (name: string) => ({ name, summary: '', body: '', reserved: ['未来未知'], applicability: { kind: 'unknown' }, references: [], links: [], person: null })
    class Child extends LlmAdapter {
      private step = 0
      constructor(private readonly owner: string, private readonly jobs: Array<() => Job>, private readonly save: (value: Record<string, unknown>, step: number) => void) { super() }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (this.step > 0 && this.step <= this.jobs.length) this.save(result(options, `job-${this.step - 1}`), this.step - 1)
        if (this.step < this.jobs.length) {
          const job = this.jobs[this.step]; assert.ok(job); const input = job(); yield call(`job-${this.step++}`, input.name, input.args)
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
        }
        assert.ok(paths[this.owner], `${this.owner} 未返回实际成果路径`)
        if (this.step === this.jobs.length) {
          this.step++
          yield call('catalog', 'catalog_register', { path: paths[this.owner], summary: `${this.owner} 成果` })
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
        }
        result(options, 'catalog')
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `成果：${paths[this.owner]}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const savePath = (owner: string) => (value: Record<string, unknown>) => { assert.equal(typeof value.path, 'string'); paths[owner] = `${owner}/${value.path}` }
    const child = {
      basics: new Child('basics', [() => ({ name: 'save_world_basics', args: { content: city ? '城邦缺水；外海留白。' : '力量无善恶；远方留白。' } })], value => { assert.equal(typeof value.path, 'string'); paths.basics = String(value.path) }),
      map: new Child('map', [() => ({ name: 'map_overview_create', args: { name: '世界', description: '', scale: { width: 1000, height: 1000, unit: 'km' }, layers: [{ id: 'area', name: '地区' }], orientation: '北', reserved: ['远方未知'] } }),
        () => ({ name: 'map_place_create', args: { name: point, aliases: [], description: '', detailLevel: 'overview', reserved: [], parents: [{ layerId: 'area', parent: { kind: 'world' }, localBoxes: [[0, 0, 100, 100]], frameBox: [0, 0, 100, 100], coverage: 'complete' }] } })], (value, step) => { if (step === 1) { ids.place = String(value.id); savePath('map')(value) } }),
      characters: new Child('characters', [() => ({ name: 'character_create', args: { character: { name: '林岚', summary: '', categories: {}, body: '拥有独立目标。' } } })], value => { ids.person = String(value.id); paths.characters = `characters/${ids.person}/profile.md` }),
      organization: new Child('organization', [() => ({ name: 'organization_create', args: { content: { name: group, aliases: [], organizationType: '组织', detailLevel: 'overview', minLevel: 0, sections: [], locations: [{ place: { kind: 'linked', id: ids.place }, purpose: '驻地', minLevel: 0 }], reserved: [] } } }),
        () => ({ name: 'organization_membership_create', args: { content: { organizationId: ids.organization, person: { kind: 'linked', id: ids.person }, roles: ['成员'], period: null, description: '', minLevel: 0 } } })], (value, step) => { if (step === 0) { ids.organization = String(value.id); savePath('organization')(value) } }),
      history: new Child('history', [() => ({ name: 'history_event_create', args: { content: { name: '旧事', aliases: [], detailLevel: 'overview', summary: '', body: '', time: [], parents: [], childrenCoverage: 'unknown', relations: [], references: [{ kind: 'linked', type: 'place', id: ids.place, description: '' }], publicAccounts: [], hidden: { state: 'unknown', note: '' }, reserved: [] } } })], savePath('history')),
      situation: new Child('situation', [() => ({ name: 'situation_start_create', args: { description: '演化起点' } }),
        () => ({ name: 'situation_overview_create', args: { content: { name: '方案 A', summary: '当前处境', coverage: point, reserved: [] } } }),
        ...(city ? [() => ({ name: 'situation_overview_create', args: { content: { name: '方案 B', summary: '另一候选', coverage: point, reserved: [] } } })] : [])], (value, step) => { if (step >= 1) { ids[`situation${step}`] = String(value.id); if (step === 1) savePath('situation')(value) } }),
      development: new Child('development', [() => ({ name: 'world_development_create', args: { kind: 'macro-blueprint', content: development('世界方向') } }),
        () => ({ name: 'world_development_create', args: { kind: 'storyline', content: development('故事线') } }),
        () => ({ name: 'world_development_create', args: { kind: 'growth-line', content: { ...development('林岚成长线'), person: { kind: 'linked', id: ids.person } } } }),
        () => ({ name: 'world_development_create', args: { kind: 'growth-blueprint', content: { ...development('人物成长蓝图'), links: [{ targetKind: 'growth-line', targetId: ids.growthLine, relation: '成长重点', description: '' }] } } }),
        () => ({ name: 'world_development_create', args: { kind: 'direction', content: { ...development('方案 A 方向'), applicability: { kind: 'scoped', scopes: [{ overviewId: ids.situation1, description: '方案 A', situationIds: [] }] } } } }),
        ...(city ? [() => ({ name: 'world_development_create', args: { kind: 'direction', content: { ...development('方案 B 方向'), applicability: { kind: 'scoped', scopes: [{ overviewId: ids.situation2, description: '方案 B', situationIds: [] }] } } } })] : [])], (value, step) => { if (step === 0) { ids.blueprint = String(value.id); savePath('development')(value) } else if (step === 2) ids.growthLine = String(value.id) }),
      specific: new Child('specific', [() => ({ name: 'world_specific_topic_create', args: { content: { name: city ? '水利' : '修炼', aliases: [], detailLevel: 'overview', summary: '', body: '', reserved: [], topicIds: [], links: [], references: [{ kind: 'linked', type: 'development-macro-blueprint', id: ids.blueprint, description: '', observedVersion: null }] } } })], savePath('specific')),
    }
    const tools = ['delegate_world_basics', 'delegate_map', 'delegate_character_creator', 'delegate_organization', 'delegate_history', 'delegate_initial_situation', 'delegate_world_development', ...(!city ? ['delegate_world_specific'] : [])]
    const orderedOwners = ['basics', 'map', 'characters', 'organization', 'history', 'situation', 'development', ...(!city ? ['specific'] : [])]
    let planPath = ''
    class Parent extends LlmAdapter {
      private step = 0
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const step = this.step++
        if (step > 0 && step <= tools.length) { const value = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === `delegate-${step - 1}`); assert.ok(value && value.type === 'tool-result' && !value.isError, JSON.stringify(value)) }
        if (step < tools.length) yield call(`delegate-${step}`, tools[step]!, { task: `${city ? '城邦' : '修仙'}世界按需规划，保留远方未知。` })
        else if (step < tools.length + orderedOwners.length) {
          const index = step - tools.length; const path = paths[orderedOwners[index]!]; assert.ok(path)
          yield call(`read-${index}`, 'read', { file_path: path })
        } else if (step === tools.length + orderedOwners.length) {
          for (let i = 0; i < orderedOwners.length; i++) { const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === `read-${i}`); assert.ok(block && block.type === 'tool-result' && !block.isError, `正文读取 ${i}`) }
          yield call('plan', 'save_first_world_plan', { content: `${city ? '城邦缺水' : '力量无善恶'}；远方未知。实际成果：${orderedOwners.map(owner => paths[owner]).join('、')}。${city ? `候选 A ${ids.situation1} 和候选 B ${ids.situation2} 均待审，各自发展方向未发生。` : '发展方向是未来可能性。'}` })
        } else {
          const saved = result(options, 'plan'); assert.equal(saved.status, 'saved'); planPath = String(saved.path)
          yield { type: 'block-end', index: 0, block: { type: 'text', text: `待审总览：${planPath}` } }; yield { type: 'finish', reason: { kind: 'stop' } }; return
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    const mock = t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Parent() }))
    const common = { sessionRoot, sessionMode: 'create' as const, provider: 'test', model: 'test', maxSteps: 12 }
    const config = (agentId: keyof typeof child) => ({ ...common, agentId, sessionId: agentId, adapter: child[agentId] })
    const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], worldId, { ...config('characters'), initializeCharacters: true, defaultCharacterCount: 1 },
      { singleWriterProcess: true, mainMaxSteps: 30, catalog: {}, mainSession: { sessionRoot, sessionId: 'main', sessionMode: 'create' }, worldBasics: config('basics'), mapAgent: config('map'), organizationAgent: config('organization'), historyAgent: config('history'), initialSituationAgent: config('situation'), worldDevelopmentAgent: config('development'), worldSpecificAgent: config('specific') })
    try {
      const answer = await parent.run({ prompt: city ? '构想已确认：城邦缺水，近期规划。' : '构想已确认：力量无善恶，近期规划。' })
      assert.match(answer.content, /待审总览/)
      const plan = await readFile(join(readRoot, planPath), 'utf8'); assert.match(plan, /远方未知/)
      for (const owner of orderedOwners) assert.ok(plan.includes(paths[owner]!), owner)
      const catalog: unknown = JSON.parse(await readFile(join(world.catalogRoot, 'catalog.json'), 'utf8'))
      assert.ok(catalog && typeof catalog === 'object' && 'records' in catalog && Array.isArray(catalog.records))
      assert.equal(catalog.records.length, orderedOwners.length)
      const growthFiles = await readdir(join(readRoot, 'development/storylines/growth-lines')); assert.equal(growthFiles.length, 1)
      const growthBlueprintFiles = await readdir(join(readRoot, 'development/character-growth/blueprints')); assert.equal(growthBlueprintFiles.length, 1)
      assert.match(await readFile(join(readRoot, 'development/character-growth/blueprints', growthBlueprintFiles[0]!), 'utf8'), new RegExp(ids.growthLine!))
      if (city) {
        assert.equal((await readdir(join(readRoot, 'specific/topics'))).length, 0)
        assert.match(plan, /候选 A/); assert.match(plan, /候选 B/); assert.notEqual(ids.situation1, ids.situation2)
        const directory = join(readRoot, 'development/macro-development/directions'); const files = await readdir(directory); assert.equal(files.length, 2)
        const values = await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))
        assert.ok(values.some(value => value.includes(ids.situation1!) && !value.includes(ids.situation2!)))
        assert.ok(values.some(value => value.includes(ids.situation2!) && !value.includes(ids.situation1!)))
      }
    } finally { await parent.dispose(); mock.mock.restore() }
  }
})
