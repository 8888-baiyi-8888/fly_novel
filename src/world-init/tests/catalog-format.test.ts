import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { formatCatalogDocument, initializeCatalog, parseCatalogDocument, readCatalog, type CatalogDocument } from '../catalog/format.js'
import type { WorldWorkspaceConfig } from '../world-workspace-config.js'

const record = { path: 'agents/main/world.md', ownerAgentId: 'main', summary: '世界草案',
  contentSha256: 'a'.repeat(64), revision: '123e4567-e89b-42d3-a456-426614174000' }
const document: CatalogDocument = { formatVersion: 1, worldId: 'world', records: [record] }

test('目录格式往返且允许成果暂时缺失，拒绝损坏、重复字段和无效记录', () => {
  assert.deepEqual(parseCatalogDocument(formatCatalogDocument(document), 'world'), document)
  assert.throws(() => parseCatalogDocument('{', 'world'))
  assert.throws(() => parseCatalogDocument('{"formatVersion":1,"worldId":"world","worldId":"world","records":[]}', 'world'))
  assert.throws(() => parseCatalogDocument(formatCatalogDocument(document), 'other'), /世界身份/)
  for (const invalid of [
    { ...document, formatVersion: 2 }, { ...document, extra: true },
    { ...document, records: [record, record] }, { ...document, records: [{ ...record, extra: 1 }] },
    { ...document, records: [{ ...record, path: '../outside' }] }, { ...document, records: [{ ...record, path: 'a\\b' }] },
    { ...document, records: [{ ...record, ownerAgentId: ' ' }] }, { ...document, records: [{ ...record, summary: ' ' }] },
    { ...document, records: [{ ...record, contentSha256: 'bad' }] }, { ...document, records: [{ ...record, revision: 'bad' }] },
  ]) assert.throws(() => parseCatalogDocument(JSON.stringify(invalid), 'world'))
  if (process.platform === 'win32') assert.throws(() => parseCatalogDocument(JSON.stringify({ ...document, records: [record, { ...record, path: record.path.toUpperCase() }] }), 'world'))
})

test('初始化只创建不存在的目录文件，读取损坏文件失败并保留数据', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'catalog-format-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['main', 'catalog', 'confirmed']) await mkdir(join(root, dir))
  const world: WorldWorkspaceConfig = { worldId: 'world', readRoot: root, catalogRoot: join(root, 'catalog'),
    confirmedRoot: join(root, 'confirmed'), mainAgent: { agentId: 'main', writableRoot: join(root, 'main') }, agents: [] }
  await assert.rejects(readCatalog(world))
  await initializeCatalog(world.catalogRoot, 'world')
  assert.deepEqual(await readCatalog(world), { formatVersion: 1, worldId: 'world', records: [] })
  await assert.rejects(initializeCatalog(world.catalogRoot, 'world'))
  const file = join(world.catalogRoot, 'catalog.json')
  await writeFile(file, '{invalid')
  await assert.rejects(readCatalog(world))
  await assert.rejects(initializeCatalog(world.catalogRoot, 'world'))
  assert.equal(await readFile(file, 'utf8'), '{invalid')
  const missing = { ...record, path: 'main/missing.md' }
  await writeFile(file, formatCatalogDocument({ ...document, records: [missing] }))
  assert.deepEqual((await readCatalog(world)).records, [missing])
  await mkdir(join(root, 'main', 'real'))
  await writeFile(join(root, 'main', 'real', 'file.md'), '内容')
  await symlink(join(root, 'main', 'real'), join(root, 'main', 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  const duplicate = { ...document, records: [{ ...record, path: 'main/real/file.md' }, { ...record, path: 'main/alias/file.md' }] }
  const original = formatCatalogDocument(duplicate)
  await writeFile(file, original)
  await assert.rejects(readCatalog(world), /重复目标/)
  assert.equal(await readFile(file, 'utf8'), original)
})
