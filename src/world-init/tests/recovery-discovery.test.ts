import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { discoverInitialization, pageDiscovery } from '../recovery/discovery.js'

test('只读发现区分有效记录、未知版本、身份冲突和损坏，并保持分页版本', async () => {
  const base = await mkdtemp(join(tmpdir(), 'world-discovery-'))
  try {
    const root = join(base, 'world'); const discussion = join(base, 'discussion')
    for (const dir of [root, join(root, 'confirmed'), join(root, 'catalog'), join(root, 'main'), discussion, join(discussion, 'discussions'), join(discussion, 'candidates')]) await mkdir(dir)
    const world = { worldId: 'one', readRoot: root, confirmedRoot: join(root, 'confirmed'), catalogRoot: join(root, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(root, 'main') }, agents: [] }
    const id = randomUUID(); const target = { kind: 'place', id: randomUUID() }
    const path = join(discussion, 'discussions', `${id}.json`)
    const content = JSON.stringify({ formatVersion: 1, worldId: 'one', id, target, sessionId: 'session' })
    await writeFile(path, content)
    const unknownId = randomUUID(); await writeFile(join(discussion, 'candidates', `${unknownId}.json`), '{"formatVersion":99}')
    const foreignId = randomUUID(); await writeFile(join(discussion, 'discussions', `${foreignId}.json`), JSON.stringify({ formatVersion: 1, worldId: 'other', id: foreignId, target, sessionId: 's' }))
    const brokenId = randomUUID(); await writeFile(join(discussion, 'discussions', `${brokenId}.json`), '{"formatVersion":1,"formatVersion":1}')
    const options = { worlds: [world], worldId: 'one', roots: { discussion }, sessionRoots: [] }
    const orphanId = randomUUID(); await writeFile(join(discussion, 'candidates', orphanId + '.json'), JSON.stringify({ formatVersion: 1, worldId: 'one', id: orphanId, discussionId: randomUUID(), target, baseline: 'base', content: 'content', summary: 'summary', status: 'active' }))
    const result = await discoverInitialization(options)
    assert.equal(result.entries.find(item => item.name === `${id}.json`)?.status, 'valid')
    assert.equal(result.entries.find(item => item.name === `${unknownId}.json`)?.status, 'unsupported-version')
    assert.equal(result.entries.find(item => item.name === `${foreignId}.json`)?.status, 'invalid')
    assert.equal(result.entries.find(item => item.name === `${brokenId}.json`)?.status, 'invalid')
    assert.equal(result.scopes.find(item => item.kind === 'discussion')?.status, 'partial')
    assert.deepEqual(result.issues, []) // 讨论范围不完整时不能断言候选孤立。
    await rm(join(discussion, 'discussions', brokenId + '.json'))
    await rm(join(discussion, 'discussions', foreignId + '.json'))
    const complete = await discoverInitialization(options)
    assert.match(complete.issues[0] ?? '', /未找到所属讨论/)
    assert.equal(result.scopes.find(item => item.kind === 'impact')?.status, 'unconfigured')
    assert.equal(await readFile(path, 'utf8'), content)
    const page = pageDiscovery(result, { limit: 1 })
    assert.equal(pageDiscovery(result, { offset: 1, limit: 1, version: page.version }).entries.length, 1)
    assert.throws(() => pageDiscovery(result, { offset: 1, version: 'stale' }))
    await assert.rejects(discoverInitialization({ ...options, roots: { discussion: root } }))
  } finally { await rm(base, { recursive: true, force: true }) }
})
