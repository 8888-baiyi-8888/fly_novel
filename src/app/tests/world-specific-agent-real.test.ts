import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseSpecificJson, specificDocumentSchema } from '@fly-novel/world-specific'
import { createWorldSpecificAgent } from '../agents/world-specific-agent.js'
import { loadConfiguredAdapter } from '../call-llm.js'

test('真实模型读取背景并自主补充世界专有内容', { skip: process.env.FLY_NOVEL_REAL_LLM_TEST !== '1', timeout: 240000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true }); const resume = process.env.FLY_NOVEL_SPECIFIC_REAL_RESUME_ROOT
  const root = resume ? await realpath(resume) : await realpath(await mkdtemp(join(tmp, 'specific-real-'))); t.diagnostic(`独立测试目录：${root}`)
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  if (!resume) {
    for (const name of ['main', 'confirmed', 'catalog', 'specific/topics', 'specific/items', 'specific/candidates']) await mkdir(join(readRoot, name), { recursive: true }); await mkdir(sessionRoot)
    await writeFile(join(readRoot, 'confirmed', 'background.md'), '这是开放的修仙世界，修行者利用灵气，灵脉变化曾迫使宗门迁徙。力量本身无善恶，灵脉变化的幕后原因未知；远方区域明确留白。\n', 'utf8')
  }
  const world = { worldId: 'specific-real', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'specific', writableRoot: join(readRoot, 'specific') }] }
  const model = await loadConfiguredAdapter('deepseek'); const agent = await createWorldSpecificAgent({ workspaces: [world], worldId: world.worldId, agentId: 'specific', sessionId: 'real', sessionRoot, sessionMode: resume ? 'resume' : 'create', ...model, singleWriterProcess: true })
  try {
    const response = await agent.run({ prompt: resume ? '继续。先核实已经保存的主题和内容；如果已有至少一个主题及其关联内容，直接报告成果和未知，不重复创建。仅在缺少成果时补做。' : '请先读取 confirmed/background.md。根据已有世界构想自主判断近期需要补充的专有设定，实际保存至少一个主题及其一个具体内容项；不要把未知幕后原因当作事实，不要填充远方留白。最后报告成果和未知。' })
    const load = async (folder: string) => Promise.all((await readdir(join(readRoot, 'specific', folder))).filter(name => name.endsWith('.json')).map(async name => parseSpecificJson(await readFile(join(readRoot, 'specific', folder, name), 'utf8'), specificDocumentSchema)))
    const topics = await load('topics'); const items = await load('items')
    assert.ok(topics.length && items.length, '未保存自主识别的主题和内容')
    assert.ok(items.some(item => item.topicIds.some(id => topics.some(topic => topic.id === id))), '内容未关联实际主题')
    assert.ok([...topics, ...items].every(item => item.contentStatus === 'suggested')); assert.ok(response.content.length > 0)
    t.diagnostic(`主题 ${topics.length}，内容 ${items.length}；实际内容需人工审阅`)
  } finally { await agent.dispose() }
})
