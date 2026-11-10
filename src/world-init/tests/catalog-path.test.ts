import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { resolveCatalogTarget } from '../catalog/path.js'
import type { WorldWorkspaceConfig } from '../world-workspace-config.js'

test('仅解析所属 Agent 的现有普通文件，链接别名归一且越权拒绝', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'catalog-path-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const otherWorld = join(root, 'other-world')
  for (const dir of ['main/sub', 'characters', 'confirmed', 'catalog']) await mkdir(join(readRoot, dir), { recursive: true })
  await mkdir(otherWorld)
  const config: WorldWorkspaceConfig = { worldId: 'world', readRoot, confirmedRoot: join(readRoot, 'confirmed'),
    catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') },
    agents: [{ agentId: 'creator', writableRoot: join(readRoot, 'characters') }] }
  const file = join(readRoot, 'main', 'sub', 'world.md'); await writeFile(file, '保留成果')
  await writeFile(join(readRoot, 'characters', 'profile.md'), '角色')
  await writeFile(join(readRoot, 'confirmed', 'fact.md'), '确认')
  await writeFile(join(readRoot, 'catalog', 'catalog.json'), '目录')
  await writeFile(join(otherWorld, 'outside.md'), '外部')
  assert.deepEqual(await resolveCatalogTarget(config, 'main', 'main/sub/world.md'), { path: 'main/sub/world.md', absolutePath: await realpath(file) })
  for (const path of ['../other-world/outside.md', file, 'main/../characters/profile.md', 'main/missing.md',
    'main/sub', 'characters/profile.md', 'confirmed/fact.md', 'catalog/catalog.json']) {
    await assert.rejects(resolveCatalogTarget(config, 'main', path))
  }
  await assert.rejects(resolveCatalogTarget(config, 'unknown', 'main/sub/world.md'), /负责人/)
  const inside = join(readRoot, 'main', 'alias')
  const outside = join(readRoot, 'main', 'escape')
  await symlink(join(readRoot, 'main', 'sub'), inside, process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(otherWorld, outside, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await resolveCatalogTarget(config, 'main', 'main/alias/world.md')).path, 'main/sub/world.md')
  await assert.rejects(resolveCatalogTarget(config, 'main', 'main/escape/outside.md'), /授权范围/)
  if (process.platform === 'win32') {
    assert.equal((await resolveCatalogTarget(config, 'main', 'MAIN/SUB/WORLD.MD')).path, 'main/sub/world.md')
  }
  assert.equal(await readFile(file, 'utf8'), '保留成果')
})
