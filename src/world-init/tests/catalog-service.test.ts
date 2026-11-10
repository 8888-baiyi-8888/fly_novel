import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { initializeCatalog } from '../workspace/catalog/format.js'
import { CatalogService } from '../workspace/catalog/service.js'
import type { WorldWorkspaceConfig } from '../workspace/config.js'

const deployment = { singleWriterProcess: true } as const

async function setup(t: TestContext, expectCloseFailure = false) {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'catalog-service-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['main', 'characters', 'catalog', 'confirmed']) await mkdir(join(root, dir))
  const config: WorldWorkspaceConfig = { worldId: root, readRoot: root, catalogRoot: join(root, 'catalog'), confirmedRoot: join(root, 'confirmed'),
    mainAgent: { agentId: 'main', writableRoot: join(root, 'main') }, agents: [{ agentId: 'creator', writableRoot: join(root, 'characters') }] }
  await initializeCatalog(config.catalogRoot, config.worldId)
  await writeFile(join(root, 'main', 'world.md'), '世界')
  await writeFile(join(root, 'characters', 'person.md'), '角色')
  const service = await CatalogService.open(config, deployment)
  t.after(async () => {
    if (expectCloseFailure) await assert.rejects(service.close(), /清理失败/)
    else await service.close()
  })
  return { root, config, service, main: service.bind('main'), creator: service.bind('creator') }
}

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
  await assert.rejects(main.update(b.record.path, '越权', b.record.revision), { code: 'CATALOG_FORBIDDEN' })
  await assert.rejects(main.remove(b.record.path, b.record.revision), { code: 'CATALOG_FORBIDDEN' })
  await assert.rejects(creator.update(b.record.path, '修改', a.record.revision), { code: 'CATALOG_CONFLICT' })
  const changed = await creator.update(b.record.path, '新简介', b.record.revision)
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
  await main.update(record.path, '更新', record.revision)
  await assert.rejects(main.search({ offset: 1, version: page.version }), { code: 'CATALOG_CONFLICT' })
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
