import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createMapAgent } from '../agents/map-agent.js'
import { loadConfiguredAdapter } from '../call-llm.js'
import { parseMapPlace, parseWorldMap } from '@fly-novel/map'

test('真实模型使用地图 Agent 规划并保存城邦地图', { skip: process.env.FLY_NOVEL_REAL_LLM_TEST !== '1', timeout: 180000 }, async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'map-real-')))
  t.diagnostic(`本次独立测试目录：${root}`)
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const name of ['main', 'map/places', 'map/connections', 'confirmed', 'catalog']) await mkdir(join(readRoot, name), { recursive: true })
  await mkdir(sessionRoot)
  const world = { worldId: 'real-map-test', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'map', writableRoot: join(readRoot, 'map') }] }
  const model = await loadConfiguredAdapter('deepseek')
  const agent = await createMapAgent({ workspaces: [world], worldId: world.worldId, agentId: 'map', sessionId: 'real', sessionRoot, sessionMode: 'create', ...model, singleWriterProcess: true })
  try {
    const response = await agent.run({ prompt: '请为资源有限的河谷城邦群建立近期故事需要的地图。世界地图使用公里，外海明确留白；先建立青河地区概况，再建立其子地点曲水城，按示意坐标设定。只建立这些内容，调用地图工具实际保存；用地图工具逐层换算曲水城到世界画布，最后以 [左,上,右,下] 报告换算后的世界坐标，并报告文件路径和未覆盖范围。' })
    const overview = parseWorldMap(await readFile(join(readRoot, 'map', 'map.json'), 'utf8'))
    const names = (await readdir(join(readRoot, 'map', 'places'))).filter(name => name.endsWith('.json'))
    const places = await Promise.all(names.map(async name => parseMapPlace(await readFile(join(readRoot, 'map', 'places', name), 'utf8'))))
    const region = places.find(place => place.name === '青河地区')
    const city = places.find(place => place.name === '曲水城')
    assert.ok(overview.reserved.some(value => value.includes('外海')), '世界地图未保存外海留白')
    assert.equal(overview.reserved.length, 1, '世界地图增加了用户未要求的留白')
    assert.ok(region && city, '模型未创建要求的两个地点')
    assert.ok(city.parents.some(parent => parent.parent.kind === 'place' && parent.parent.id === region.id), '城市未引用要求的父地点')
    const parent = region.parents.find(link => link.parent.kind === 'world')
    const child = city.parents.find(link => link.parent.kind === 'place' && link.parent.id === region.id)
    assert.ok(parent?.frameBox && child?.localBoxes[0], '缺少逐层换算所需参考框或城市范围')
    const [left, top, right, bottom] = parent.frameBox; const [x1, y1, x2, y2] = child.localBoxes[0]
    const expected = [left + x1 * (right-left) / 1000, top + y1 * (bottom-top) / 1000, left + x2 * (right-left) / 1000, top + y2 * (bottom-top) / 1000].map(value => Math.round(value * 1e6) / 1e6)
    assert.ok(response.content.replace(/\s/g, '').includes(JSON.stringify(expected)), `模型最终报告未包含正确世界坐标 ${JSON.stringify(expected)}`)
    t.diagnostic(`成果目录：${root}；地图层面 ${overview.layers.length} 个，地点 ${places.length} 个；模型返回 ${response.content.length} 字`)
  } finally { await agent.dispose() }
})
