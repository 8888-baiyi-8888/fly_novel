import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseHistoryEvent } from '@fly-novel/history'
import { createHistoryAgent } from '../agents/history-agent.js'
import { loadConfiguredAdapter } from '../call-llm.js'

test('真实模型保存城邦历史及子事件', { skip: process.env.FLY_NOVEL_REAL_LLM_TEST !== '1', timeout: 240000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true })
  const resume = process.env.FLY_NOVEL_HISTORY_REAL_RESUME_ROOT
  const root = resume ? await realpath(resume) : await realpath(await mkdtemp(join(tmp, 'history-real-')))
  t.diagnostic(`独立测试目录：${root}`)
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  if (!resume) {
    for (const name of ['main', 'history/events', 'history/candidates', 'confirmed', 'catalog']) await mkdir(join(readRoot, name), { recursive: true })
    await mkdir(sessionRoot)
    await writeFile(join(readRoot, 'confirmed', 'background.md'), '青河城邦群缺水；过去发生过青河战争，战争年代和幕后原因未知。战争期间曾有停战谈判。\n', 'utf8')
  }
  const world = { worldId: 'history-real', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'history', writableRoot: join(readRoot, 'history') }] }
  const model = await loadConfiguredAdapter('deepseek')
  const agent = await createHistoryAgent({ workspaces: [world], worldId: world.worldId, agentId: 'history', sessionId: 'real', sessionRoot, sessionMode: resume ? 'resume' : 'create', ...model, singleWriterProcess: true })
  try {
    const response = await agent.run({ prompt: resume ? '继续。先核实已经保存的事件，避免重复创建，然后完成原任务。' : '请读取 confirmed/background.md，按背景保存历史事件“青河战争”和它的子事件“停战谈判”，保留年代及幕后原因未知，不编造人物 ID。最后说明成果与留白。' })
    const directory = join(readRoot, 'history', 'events')
    const events = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).map(async name => parseHistoryEvent(await readFile(join(directory, name), 'utf8'))))
    const war = events.find(event => event.name === '青河战争'); const negotiation = events.find(event => event.name === '停战谈判')
    assert.ok(war && negotiation, '未保存指定的历史事件和子事件')
    assert.ok(negotiation.parents.some(parent => parent.id === war.id), '子事件未关联战争')
    assert.equal(war.hidden.state, 'unknown'); assert.ok(events.every(event => event.contentStatus === 'suggested'))
    assert.ok(response.content.length > 0)
    t.diagnostic(`历史事件 ${events.length}；模型回复 ${response.content.length} 字，具体内容需人工审阅`)
  } finally { await agent.dispose() }
})
