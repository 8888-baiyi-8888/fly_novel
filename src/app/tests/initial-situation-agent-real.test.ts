import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseJson, situationSchema, overviewSchema, startSchema } from '@fly-novel/initial-situation'
import { createInitialSituationAgent } from '../agents/initial-situation-agent.js'
import { loadConfiguredAdapter } from '../call-llm.js'

test('真实模型保存城邦初始局势', { skip: process.env.FLY_NOVEL_REAL_LLM_TEST !== '1', timeout: 240000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true })
  const resume = process.env.FLY_NOVEL_SITUATION_REAL_RESUME_ROOT; const root = resume ? await realpath(resume) : await realpath(await mkdtemp(join(tmp, 'situation-real-')))
  t.diagnostic(`独立测试目录：${root}`)
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  if (!resume) {
    for (const name of ['main', 'situation/overviews', 'situation/situations', 'situation/candidates', 'confirmed', 'catalog']) await mkdir(join(readRoot, name), { recursive: true })
    await mkdir(sessionRoot); await writeFile(join(readRoot, 'confirmed', 'background.md'), '青河城邦群过去经历战争。故事起点上游限制水渠供水，下游抗议；幕后原因和未来结果未知。\n', 'utf8')
  }
  const world = { worldId: 'situation-real', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'situation', writableRoot: join(readRoot, 'situation') }] }
  const model = await loadConfiguredAdapter('deepseek'); const agent = await createInitialSituationAgent({ workspaces: [world], worldId: world.worldId, agentId: 'situation', sessionId: 'real', sessionRoot, sessionMode: resume ? 'resume' : 'create', ...model, singleWriterProcess: true })
  try {
    const response = await agent.run({ prompt: resume ? '继续。先核实已经保存的起点、方案和局势，避免重复创建，再完成原任务。' : '请读取 confirmed/background.md。为这个世界保存一个起始时点、一份名为“河谷局势”的待审方案，以及一条名为“供水争议”的局势。保留幕后原因和未来结果未知，不编造已有对象 ID。最后报告成果和留白。' })
    const base = join(readRoot, 'situation'); parseJson(await readFile(join(base, 'start.json'), 'utf8'), startSchema)
    const load = async (folder: string) => Promise.all((await readdir(join(base, folder))).filter(name => name.endsWith('.json')).map(name => readFile(join(base, folder, name), 'utf8')))
    const plans = (await load('overviews')).map(text => parseJson(text, overviewSchema)); const situations = (await load('situations')).map(text => parseJson(text, situationSchema))
    const plan = plans.find(item => item.name === '河谷局势'); const item = situations.find(value => value.name === '供水争议')
    assert.ok(plan && item, '未保存指定方案与局势'); assert.equal(item.overviewId, plan.id); assert.equal(plan.contentStatus, 'suggested'); assert.equal(item.contentStatus, 'suggested'); assert.ok(response.content.length > 0)
    t.diagnostic(`方案 ${plans.length}，局势 ${situations.length}；模型回复 ${response.content.length} 字，具体内容需人工审阅`)
  } finally { await agent.dispose() }
})
