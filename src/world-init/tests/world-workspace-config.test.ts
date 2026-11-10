import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../workspace/config.js'

async function fixture(t: TestContext) {
  const parent = join(process.cwd(), 'tmp')
  await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'world-config-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const makeWorld = async (worldId: string): Promise<WorldWorkspaceConfig> => {
    const readRoot = join(root, worldId)
    const dirs = ['confirmed', 'catalog', 'main', 'characters', 'geography']
    for (const dir of dirs) await mkdir(join(readRoot, dir), { recursive: true })
    return { worldId, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
      mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') },
      agents: [{ agentId: 'characters', writableRoot: join(readRoot, 'characters') }, { agentId: 'geography', writableRoot: join(readRoot, 'geography') }] }
  }
  const a = await makeWorld('world-a')
  const b = await makeWorld('world-b')
  const sentinel = join(a.mainAgent.writableRoot, 'existing.txt')
  await writeFile(sentinel, '保留原有数据')
  return { root, a, b, sentinel }
}

test('两个世界各自绑定主 Agent 和两个特殊 Agent，同名身份独立且配置快照不可修改', async t => {
  const { a, b, sentinel } = await fixture(t)
  const result = await validateWorldWorkspaceConfigs([a, b])
  assert.deepEqual(result, [a, b])
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result[0]) && Object.isFrozen(result[0]!.agents) && Object.isFrozen(result[0]!.agents[0]))
  assert.notEqual(result[0]!.agents[0]!.writableRoot, result[1]!.agents[0]!.writableRoot)
  assert.equal(await readFile(sentinel, 'utf8'), '保留原有数据')
})

test('拒绝身份冲突、目录越界、目录重叠和缺失，保留现有文件', async t => {
  const { root, a, b, sentinel } = await fixture(t)
  await assert.rejects(validateWorldWorkspaceConfigs([a, { ...b, worldId: a.worldId }]), /世界 ID 重复/)
  await assert.rejects(validateWorldWorkspaceConfigs([{ ...a, agents: [...a.agents, a.mainAgent] }]), /Agent ID 重复/)
  await assert.rejects(validateWorldWorkspaceConfigs([{ ...a, catalogRoot: a.confirmedRoot }]), /不能重叠/)
  await assert.rejects(validateWorldWorkspaceConfigs([{ ...a, mainAgent: { ...a.mainAgent, writableRoot: a.agents[0]!.writableRoot } }]), /不能重叠/)
  const nested = join(a.mainAgent.writableRoot, 'nested'); await mkdir(nested)
  await assert.rejects(validateWorldWorkspaceConfigs([{ ...a, catalogRoot: nested }]), /不能重叠/)
  await assert.rejects(validateWorldWorkspaceConfigs([{ ...a, catalogRoot: b.catalogRoot }]), /必须位于世界读取根内/)
  await assert.rejects(validateWorldWorkspaceConfigs([{ ...a, catalogRoot: join(root, 'missing') }]))
  await assert.rejects(validateWorldWorkspaceConfigs([{ ...a, catalogRoot: 'relative' }]), /绝对目录/)
  await assert.rejects(validateWorldWorkspaceConfigs([{ ...a, catalogRoot: sentinel }]), /现有目录/)
  const nestedDirs = ['confirmed', 'catalog', 'main']
  for (const dir of nestedDirs) await mkdir(join(nested, dir))
  await assert.rejects(validateWorldWorkspaceConfigs([a, { worldId: 'nested', readRoot: nested,
    confirmedRoot: join(nested, 'confirmed'), catalogRoot: join(nested, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(nested, 'main') }, agents: [] }]), /不同世界的读取根不能重叠/)
  await assert.rejects(validateWorldWorkspaceConfigs([a, { ...a, worldId: 'other' }]), /不同世界的读取根不能重叠/)
  assert.equal(await readFile(sentinel, 'utf8'), '保留原有数据')
})

test('拒绝符号链接或 junction 作为配置目录，并按实际平台检查大小写别名', async t => {
  const { root, a, b } = await fixture(t)
  const link = join(root, 'alias')
  await symlink(a.readRoot, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(validateWorldWorkspaceConfigs([{ ...a, readRoot: link }]), /真实路径/)
  const alias = join(a.readRoot, 'catalog-alias')
  await symlink(a.confirmedRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(validateWorldWorkspaceConfigs([{ ...a, catalogRoot: alias }]), /真实路径/)
  if (process.platform === 'win32') {
    const differentCase = a.readRoot.toUpperCase()
    await assert.rejects(validateWorldWorkspaceConfigs([a, { ...b, readRoot: differentCase }]))
  }
})
