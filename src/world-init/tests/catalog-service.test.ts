import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { initializeCatalog } from '../workspace/catalog/format.js'
import { CatalogService } from '../workspace/catalog/service.js'
import type { WorldWorkspaceConfig } from '../workspace/config.js'

const deployment = { singleWriterProcess: true } as const

async function setup(t: TestContext, expectCloseFailure = false, options: { maxSourceBytes?: number; receiptTtlMs?: number; maxReceipts?: number } = {}) {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'catalog-service-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['main', 'characters', 'catalog', 'confirmed']) await mkdir(join(root, dir))
  const config: WorldWorkspaceConfig = { worldId: root, readRoot: root, catalogRoot: join(root, 'catalog'), confirmedRoot: join(root, 'confirmed'),
    mainAgent: { agentId: 'main', writableRoot: join(root, 'main') }, agents: [{ agentId: 'creator', writableRoot: join(root, 'characters') }] }
  await initializeCatalog(config.catalogRoot, config.worldId)
  await writeFile(join(root, 'main', 'world.md'), '世界')
  await writeFile(join(root, 'characters', 'person.md'), '角色')
  const service = await CatalogService.open(config, { ...deployment, ...options })
  t.after(async () => {
    if (expectCloseFailure) await assert.rejects(service.close(), /清理失败/)
    else await service.close()
  })
  return { root, config, service, main: service.bind('main'), creator: service.bind('creator') }
}

test('读取凭据绑定实例和版本，变化、关闭及重复使用均拒绝', async t => {
  const { root, service, main, creator } = await setup(t)
  const record = (await main.register('main/world.md', '原简介')).record
  const source = await main.readSource(record.path, record.revision)
  assert.equal(source.content, '世界')
  const another = service.bind('main')
  await assert.rejects(another.update(record.path, '伪造', record.revision, source.receipt), { code: 'CATALOG_RECEIPT_INVALID' })
  await assert.rejects(creator.update(record.path, '伪造', record.revision, source.receipt), { code: 'CATALOG_RECEIPT_INVALID' })
  await writeFile(join(root, 'main', 'world.md'), '改变')
  await assert.rejects(main.update(record.path, '过期简介', record.revision, source.receipt), { code: 'CATALOG_CONFLICT' })
  await assert.rejects(main.update(record.path, '重用', record.revision, source.receipt), { code: 'CATALOG_RECEIPT_INVALID' })
  assert.equal((await main.read(record.path))?.record.summary, '原简介')
  const fresh = await main.readSource(record.path, record.revision)
  const updated = await main.update(record.path, '新简介', record.revision, fresh.receipt)
  assert.equal(updated.fileStatus, 'current')
  await assert.rejects(main.update(record.path, '重用', record.revision, fresh.receipt), { code: 'CATALOG_RECEIPT_INVALID' })
  const last = await main.readSource(record.path, updated.record.revision)
  await main.close()
  await assert.rejects(main.update(record.path, '关闭后', updated.record.revision, last.receipt), { code: 'CATALOG_CLOSED' })
  await assert.rejects(another.update(record.path, '跨实例', updated.record.revision, last.receipt), { code: 'CATALOG_RECEIPT_INVALID' })
  await another.close()
})

test('凭据上限、过期、文件过大和不支持的编码均明确拒绝', async t => {
  const { root, main } = await setup(t, false, { maxSourceBytes: 16, maxReceipts: 1, receiptTtlMs: 1 })
  const record = (await main.register('main/world.md', '简介')).record
  const first = await main.readSource(record.path, record.revision)
  await new Promise(resolve => setTimeout(resolve, 10))
  await assert.rejects(main.update(record.path, '过期', record.revision, first.receipt), { code: 'CATALOG_RECEIPT_INVALID' })
  await writeFile(join(root, 'main', 'world.md'), 'x'.repeat(17))
  await assert.rejects(main.readSource(record.path, record.revision), { code: 'CATALOG_SOURCE_TOO_LARGE' })
  await writeFile(join(root, 'main', 'world.md'), Buffer.from([0xff]))
  await assert.rejects(main.readSource(record.path, record.revision), { code: 'CATALOG_SOURCE_ENCODING' })
})

test('有效凭据达到上限时拒绝新凭据', async t => {
  const { main } = await setup(t, false, { maxReceipts: 1 })
  const record = (await main.register('main/world.md', '简介')).record
  const source = await main.readSource(record.path, record.revision)
  await assert.rejects(main.readSource(record.path, record.revision), { code: 'CATALOG_RECEIPT_LIMIT' })
  await main.update(record.path, '更新', record.revision, source.receipt)
})

test('完整读取期间成果变化时不签发凭据', async t => {
  const { root, service, main } = await setup(t)
  const record = (await main.register('main/world.md', '简介')).record
  const fs: unknown = Reflect.get(service, 'fs'); assert.ok(fs instanceof LocalFileSystem)
  const read = fs.readBytes.bind(fs)
  const mocked = t.mock.method(fs, 'readBytes', async (...args: Parameters<typeof read>) => {
    const result = await read(...args)
    await writeFile(join(root, 'main', 'world.md'), '读取期间的变更')
    return result
  })
  await assert.rejects(main.readSource(record.path, record.revision), { code: 'CATALOG_CONFLICT' })
  mocked.mock.restore()
  assert.equal((await main.readSource(record.path, record.revision)).content, '读取期间的变更')
})

test('简介发布后成果变化时保留更新并报告过期', async t => {
  const { root, service, main } = await setup(t)
  const record = (await main.register('main/world.md', '简介')).record
  const source = await main.readSource(record.path, record.revision)
  const fs: unknown = Reflect.get(service, 'fs'); assert.ok(fs instanceof LocalFileSystem)
  const write = fs.writeText.bind(fs)
  t.mock.method(fs, 'writeText', async (...args: Parameters<typeof write>) => {
    const result = await write(...args)
    await writeFile(join(root, 'main', 'world.md'), '发布后的变更')
    return result
  })
  const updated = await main.update(record.path, '新简介', record.revision, source.receipt)
  assert.equal(updated.fileStatus, 'stale')
  assert.equal((await main.read(record.path))?.record.summary, '新简介')
})

test('清理失败保留世界占用，避免不安全重开', async t => {
  const { service, config } = await setup(t, true)
  const dispose: unknown = Reflect.get(service, 'disposeFs')
  assert.ok(typeof dispose === 'function')
  Object.defineProperty(service, 'disposeFs', { value: async () => { await dispose(); throw new Error('清理失败') } })
  await assert.rejects(service.close(), /清理失败/)
  await assert.rejects(CatalogService.open(config, deployment), { code: 'CATALOG_CONFLICT' })
})

test('可信配置的目录大小上限在打开时生效', async t => {
  const { service, config } = await setup(t)
  await service.close()
  await assert.rejects(CatalogService.open(config, { ...deployment, maxCatalogBytes: 1 }), /大小上限/)
  const reopened = await CatalogService.open(config, deployment)
  await reopened.close()
})

test('同世界并发登记不丢失，跨身份拒绝，更新删除检查 revision', async t => {
  const { root, config, service, main, creator } = await setup(t)
  await assert.rejects(CatalogService.open(config, deployment), { code: 'CATALOG_CONFLICT' })
  const [a, b] = await Promise.all([main.register('main/world.md', '世界建议'), creator.register('characters/person.md', '角色建议')])
  assert.equal(a.fileStatus, 'current'); assert.equal(b.fileStatus, 'current')
  assert.equal((await main.search()).total, 2)
  await assert.rejects(main.readSource(b.record.path, b.record.revision), { code: 'CATALOG_FORBIDDEN' })
  await assert.rejects(main.remove(b.record.path, b.record.revision), { code: 'CATALOG_FORBIDDEN' })
  await assert.rejects(creator.readSource(b.record.path, a.record.revision), { code: 'CATALOG_CONFLICT' })
  const source = await creator.readSource(b.record.path, b.record.revision)
  const changed = await creator.update(b.record.path, '新简介', b.record.revision, source.receipt)
  await assert.rejects(creator.remove(b.record.path, b.record.revision), { code: 'CATALOG_CONFLICT' })
  await creator.remove(b.record.path, changed.record.revision)
  assert.equal(await readFile(join(root, 'characters', 'person.md'), 'utf8'), '角色')
  const recreated = await creator.register('characters/person.md', '再次登记')
  await assert.rejects(creator.remove(b.record.path, changed.record.revision), { code: 'CATALOG_CONFLICT' })
  assert.notEqual(recreated.record.revision, b.record.revision)
  await service.close()
  await assert.rejects(main.search(), { code: 'CATALOG_CLOSED' })
})

test('关闭等待已开始的发布并拒绝新操作', async t => {
  const { service, main } = await setup(t)
  const fs: unknown = Reflect.get(service, 'fs'); assert.ok(fs instanceof LocalFileSystem)
  const original = fs.writeText.bind(fs)
  let enter!: () => void; let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(fs, 'writeText', async (...args: Parameters<typeof original>) => { enter(); await gate; return original(...args) })
  const pending = main.register('main/world.md', '简介')
  await entered
  const closing = service.close()
  await assert.rejects(main.search(), { code: 'CATALOG_CLOSED' })
  release()
  assert.equal((await pending).fileStatus, 'current')
  await closing
})

test('成果在检查期间变化时拒绝登记，发布结果不明时保留错误', async t => {
  const { root, service, main } = await setup(t)
  const fs: unknown = Reflect.get(service, 'fs'); assert.ok(fs instanceof LocalFileSystem)
  const read = fs.readByteRange.bind(fs)
  let changed = false
  const mocked = t.mock.method(fs, 'readByteRange', async (...args: Parameters<typeof read>) => {
    const result = await read(...args)
    if (!changed) { changed = true; await writeFile(join(root, 'main', 'world.md'), '变化的内容') }
    return result
  })
  await assert.rejects(main.register('main/world.md', '简介'), { code: 'CATALOG_CONFLICT' })
  mocked.mock.restore()
  assert.equal((await main.search()).total, 0)
  t.mock.method(fs, 'writeText', async () => { throw new Error('模拟发布故障') })
  await assert.rejects(main.register('main/world.md', '简介'), { code: 'CATALOG_COMMIT_UNKNOWN' })
  assert.equal((await main.search()).total, 0)
})

test('目录发布后成果发生变化时返回已登记的过期状态', async t => {
  const { root, service, main } = await setup(t)
  const fs: unknown = Reflect.get(service, 'fs'); assert.ok(fs instanceof LocalFileSystem)
  const original = fs.writeText.bind(fs)
  t.mock.method(fs, 'writeText', async (...args: Parameters<typeof original>) => {
    const result = await original(...args)
    await writeFile(join(root, 'main', 'world.md'), '发布后的变更')
    return result
  })
  const result = await main.register('main/world.md', '世界')
  assert.equal(result.fileStatus, 'stale')
  assert.equal((await main.read('main/world.md'))?.fileStatus, 'stale')
})

test('分页检测目录变化，文件变化和缺失保留记录与真实状态', async t => {
  const { root, main, creator } = await setup(t)
  await main.register('main/world.md', '世界')
  await creator.register('characters/person.md', '角色')
  const page = await main.search({ limit: 1 })
  assert.equal(page.nextOffset, 1)
  await writeFile(join(root, 'main', 'world.md'), '变更后的世界')
  assert.equal((await main.read('main/world.md'))?.fileStatus, 'stale')
  await rm(join(root, 'characters', 'person.md'))
  assert.equal((await main.read('characters/person.md'))?.fileStatus, 'missing')
  assert.equal(await main.read('main/not-registered.md'), undefined)
  const record = (await main.read('main/world.md'))!.record
  const source = await main.readSource(record.path, record.revision)
  await main.update(record.path, '更新', record.revision, source.receipt)
  await assert.rejects(main.search({ offset: 1, version: page.version }), { code: 'CATALOG_CONFLICT' })
})

test('全量检查分页保留各项状态并拒绝跨版本翻页', async t => {
  const { root, main, creator } = await setup(t)
  const empty = await main.checkPage()
  assert.equal(empty.status, 'completed'); assert.equal(empty.total, 0); assert.equal(empty.nextOffset, null)
  await main.register('main/world.md', '世界')
  await creator.register('characters/person.md', '角色')
  await writeFile(join(root, 'main', 'third.md'), '第三项')
  await main.register('main/third.md', '第三项')
  await writeFile(join(root, 'main', 'world.md'), '发生变化')
  await rm(join(root, 'characters', 'person.md'))
  const first = await main.checkPage({ limit: 1 })
  assert.equal(first.status, 'completed'); assert.equal(first.total, 3); assert.equal(first.nextOffset, 1)
  assert.equal(first.items[0]?.fileStatus, 'missing'); assert.equal(first.items[0]?.record.ownerAgentId, 'creator')
  const second = await main.checkPage({ offset: 1, limit: 1, version: first.version })
  const third = await main.checkPage({ offset: 2, limit: 1, version: first.version })
  assert.equal(second.items[0]?.fileStatus, 'current'); assert.equal(third.items[0]?.fileStatus, 'stale'); assert.equal(third.nextOffset, null)
  await assert.rejects(main.checkPage({ offset: 1 }), { code: 'CATALOG_INVALID_INPUT' })
  const record = second.items[0]!.record
  await main.remove(record.path, record.revision)
  await assert.rejects(main.checkPage({ offset: 1, version: first.version }), { code: 'CATALOG_CONFLICT' })
  assert.equal(await main.read('main/third.md'), undefined)
  assert.equal(await readFile(join(root, 'main', 'third.md'), 'utf8'), '第三项')
})

test('检查取消时保留已完成项和未检查位置', async t => {
  const { root, service, main } = await setup(t)
  await writeFile(join(root, 'main', 'a.md'), 'a')
  await writeFile(join(root, 'main', 'b.md'), 'b')
  await main.register('main/a.md', 'a'); await main.register('main/b.md', 'b')
  const fs: unknown = Reflect.get(service, 'fs'); assert.ok(fs instanceof LocalFileSystem)
  const read = fs.readByteRange.bind(fs); const controller = new AbortController()
  let calls = 0
  t.mock.method(fs, 'readByteRange', async (...args: Parameters<typeof read>) => {
    if (++calls === 2) controller.abort()
    return read(...args)
  })
  const page = await main.checkPage({}, controller.signal)
  assert.equal(page.status, 'cancelled'); assert.equal(page.items.length, 1); assert.equal(page.nextOffset, 1); assert.equal(page.total, 2)
  const rest = await main.checkPage({ offset: page.nextOffset!, version: page.version })
  assert.equal(rest.status, 'completed'); assert.equal(rest.items.length, 1); assert.equal(rest.nextOffset, null)
})

test('检查期间目录变化或损坏时不返回有效页', async t => {
  const { root, service, main } = await setup(t)
  await main.register('main/world.md', '原简介')
  const fs: unknown = Reflect.get(service, 'fs'); assert.ok(fs instanceof LocalFileSystem)
  const read = fs.readByteRange.bind(fs)
  const catalogPath = join(root, 'catalog', 'catalog.json')
  const old = await readFile(catalogPath, 'utf8')
  const mock = t.mock.method(fs, 'readByteRange', async (...args: Parameters<typeof read>) => {
    const value = await read(...args)
    await writeFile(catalogPath, old.replace('原简介', '新简介'))
    return value
  })
  await assert.rejects(main.checkPage(), { code: 'CATALOG_CONFLICT' })
  mock.mock.restore()
  await writeFile(catalogPath, '{broken')
  await assert.rejects(main.checkPage())
  assert.equal(await readFile(catalogPath, 'utf8'), '{broken')
})

test('检查分别报告不可读和失效负责人', async t => {
  const { root, service, main, creator } = await setup(t)
  await main.register('main/world.md', '世界'); await creator.register('characters/person.md', '角色')
  const catalogPath = join(root, 'catalog', 'catalog.json')
  const data = (await readFile(catalogPath, 'utf8')).replace('"ownerAgentId": "creator"', '"ownerAgentId": "removed"')
  await writeFile(catalogPath, data)
  const fs: unknown = Reflect.get(service, 'fs'); assert.ok(fs instanceof LocalFileSystem)
  t.mock.method(fs, 'readByteRange', async () => { throw Object.assign(new Error('拒绝读取'), { code: 'EACCES' }) })
  const page = await main.checkPage()
  assert.deepEqual(page.items.map(item => item.fileStatus), ['forbidden', 'unreadable'])
  assert.equal(page.items[0]?.record.ownerAgentId, 'removed')
})

test('检查期间成果变化时逐项报告 changing', async t => {
  const { root, service, main } = await setup(t)
  await main.register('main/world.md', '世界')
  const fs: unknown = Reflect.get(service, 'fs'); assert.ok(fs instanceof LocalFileSystem)
  const read = fs.readByteRange.bind(fs)
  t.mock.method(fs, 'readByteRange', async (...args: Parameters<typeof read>) => {
    const value = await read(...args)
    await writeFile(join(root, 'main', 'world.md'), '检查过程中的新内容')
    return value
  })
  const page = await main.checkPage()
  assert.equal(page.status, 'completed'); assert.equal(page.items[0]?.fileStatus, 'changing')
})

test('成果读取失败单独报告，不伪装成缺失或空结果', async t => {
  const { service, main } = await setup(t)
  await main.register('main/world.md', '世界')
  const fs: unknown = Reflect.get(service, 'fs'); assert.ok(fs instanceof LocalFileSystem)
  t.mock.method(fs, 'readByteRange', async () => { throw Object.assign(new Error('拒绝读取'), { code: 'EACCES' }) })
  assert.equal((await main.read('main/world.md'))?.fileStatus, 'unreadable')
  const page = await main.search()
  assert.equal(page.total, 1)
  assert.equal(page.items[0]?.fileStatus, 'unreadable')
})

test('取消和外部修改时不覆盖目录', async t => {
  const { root, service, main } = await setup(t)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(main.register('main/world.md', '简介', abort.signal), { code: 'ABORTED' })
  const fs: unknown = Reflect.get(service, 'fs')
  assert.ok(fs instanceof LocalFileSystem)
  const original = fs.writeText.bind(fs)
  t.mock.method(fs, 'writeText', async (...args: Parameters<typeof original>) => {
    await writeFile(join(root, 'catalog', 'catalog.json'), '{"external":true}')
    return original(...args)
  })
  await assert.rejects(main.register('main/world.md', '简介'), { code: 'CATALOG_CONFLICT' })
  assert.equal(await readFile(join(root, 'catalog', 'catalog.json'), 'utf8'), '{"external":true}')
})
