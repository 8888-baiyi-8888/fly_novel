import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { documentSchema, parseDocumentJson } from '@fly-novel/world-development'
import { createWorldDevelopmentAgent } from '../agents/world-development-agent.js'
import { loadConfiguredAdapter } from '../call-llm.js'

const dirs = ['macro-development/blueprints', 'macro-development/directions', 'macro-development/proposals', 'storylines/stories', 'storylines/growth-lines', 'character-growth/blueprints', 'character-growth/items', 'candidates']
test('真实模型保存三类世界发展规划', { skip: process.env.FLY_NOVEL_REAL_LLM_TEST !== '1', timeout: 240000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true }); const resume = process.env.FLY_NOVEL_DEVELOPMENT_REAL_RESUME_ROOT
  const root = resume ? await realpath(resume) : await realpath(await mkdtemp(join(tmp, 'development-real-'))); t.diagnostic(`独立测试目录：${root}`)
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  if (!resume) {
    for (const dir of ['main', 'confirmed', 'catalog', ...dirs.map(dir => `development/${dir}`)]) await mkdir(join(readRoot, dir), { recursive: true }); await mkdir(sessionRoot)
    await writeFile(join(readRoot, 'confirmed', 'background.md'), '青河城邦群缺水，上游限制供水，下游抗议。水渠联络人尚未建档。未来能否合作未知。\n', 'utf8')
  }
  const world = { worldId: 'development-real', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'development', writableRoot: join(readRoot, 'development') }] }
  const model = await loadConfiguredAdapter('deepseek'); const agent = await createWorldDevelopmentAgent({ workspaces: [world], worldId: world.worldId, agentId: 'development', sessionId: 'real', sessionRoot, sessionMode: resume ? 'resume' : 'create', ...model, singleWriterProcess: true })
  try {
    const response = await agent.run({ prompt: resume ? '继续。先核查已保存的规划，避免重复创建，然后完成原任务。' : '请读取 confirmed/background.md。实际保存三项世界规划：宏观蓝图“河谷发展”、故事线“水源争议”、人物成长蓝图“人物成长”。再为未建档的水渠联络人保存一条成长线，person 使用 unresolved 线索，不要编造人物 ID。保留未来是否合作未知，不预定角色选择。最后报告文件与留白。' })
    const load = async (folder: string) => Promise.all((await readdir(join(readRoot, 'development', folder))).filter(name => name.endsWith('.json')).map(async name => parseDocumentJson(await readFile(join(readRoot, 'development', folder, name), 'utf8'), documentSchema)))
    const macro = await load('macro-development/blueprints'); const stories = await load('storylines/stories'); const growth = await load('storylines/growth-lines'); const blueprint = await load('character-growth/blueprints')
    assert.ok(macro.some(item => item.name === '河谷发展') && stories.some(item => item.name === '水源争议') && blueprint.some(item => item.name === '人物成长'), '缺少指定的三类规划')
    assert.ok(growth.some(item => item.person?.kind === 'unresolved' && item.person.description.includes('联络人')), '缺少未建档人物成长线')
    assert.ok([...macro, ...stories, ...growth, ...blueprint].every(item => item.contentStatus === 'suggested')); assert.ok(response.content.length > 0)
    t.diagnostic(`宏观蓝图 ${macro.length}、故事线 ${stories.length}、成长线 ${growth.length}、成长蓝图 ${blueprint.length}；输出需人工审阅`)
  } finally { await agent.dispose() }
})
