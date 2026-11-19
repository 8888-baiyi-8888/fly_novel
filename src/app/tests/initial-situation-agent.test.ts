import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import configured = require('../call-llm.js')
import { createInitialSituationAgent } from '../agents/initial-situation-agent.js'
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'

class Script extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly calls: { name: string; args: object }[] = []) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options); const call = this.calls[this.requests.length - 1]
    if (call) { yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `step-${this.requests.length}` as ToolCallId, name: call.name, arguments: JSON.stringify(call.args) } }; yield { type: 'finish', reason: { kind: 'tool-calls' } } }
    else { yield { type: 'block-end', index: 0, block: { type: 'text', text: '局势已处理' } }; yield { type: 'finish', reason: { kind: 'stop' } } }
  }
}
async function setup(t: TestContext) {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true }); const root = await realpath(await mkdtemp(join(tmp, 'situation-agent-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const name of ['main', 'situation/overviews', 'situation/situations', 'situation/candidates', 'confirmed', 'catalog']) await mkdir(join(readRoot, name), { recursive: true })
  await mkdir(sessionRoot)
  const world = { worldId: 'situation-world', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'situation', writableRoot: join(readRoot, 'situation') }] }
  return { world, sessionRoot }
}
const overview = { name: '河谷', summary: '缺水', coverage: '城邦', reserved: [] }
test('独立局势 Agent 保存成果并恢复同一 Session', async t => {
  const { world, sessionRoot } = await setup(t); const adapter = new Script([{ name: 'situation_start_create', args: { description: '战后' } }, { name: 'situation_overview_create', args: { content: overview } }])
  const config = { workspaces: [world], worldId: world.worldId, agentId: 'situation', sessionId: 's', sessionRoot, sessionMode: 'create' as const, provider: 'test', model: 'test', adapter, singleWriterProcess: true as const }
  const agent = await createInitialSituationAgent(config); await assert.rejects(createInitialSituationAgent(config), /占用|使用/)
  try { assert.deepEqual(await agent.run({ prompt: '建立城邦局势' }), { content: '局势已处理' }) } finally { await agent.dispose() }
  assert.equal((await readdir(join(world.readRoot, 'situation/overviews'))).length, 1)
  const resumedAdapter = new Script(); const resumed = await createInitialSituationAgent({ ...config, sessionMode: 'resume', adapter: resumedAdapter })
  try { await resumed.run({ prompt: '继续' }); assert.match(JSON.stringify(resumedAdapter.requests[0]?.messages), /建立城邦局势/) } finally { await resumed.dispose() }
})
test('主 Agent 委派局势 Agent，写工具不暴露给主 Agent', async t => {
  const { world, sessionRoot } = await setup(t); await initializeCatalog(world.catalogRoot, world.worldId)
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Script() }))
  const child = new Script([{ name: 'situation_start_create', args: { description: '战后' } }, { name: 'situation_overview_create', args: { content: overview } }])
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true, catalog: {}, initialSituationAgent: { agentId: 'situation', sessionId: 's', sessionRoot, sessionMode: 'create', provider: 'test', model: 'test', adapter: child } })
  try {
    assert.ok(parent.context.tools.get('delegate_initial_situation')); assert.equal(parent.context.tools.get('situation_create'), undefined)
    assert.match(String(parent.context.systemPrompt.getSection('world-initialization:initial-situation-agent')?.text), /delegate_initial_situation/)
    const result = await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'delegate' as ToolCallId, name: 'delegate_initial_situation', arguments: JSON.stringify({ task: '规划城邦局势' }) }], workingDirectory: world.readRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal })
    assert.equal(result.results[0]?.result.isError, false); assert.equal((await readdir(join(world.readRoot, 'situation/overviews'))).length, 1)
  } finally { await parent.dispose() }
})
test('启动失败后释放局势身份，修复目录即可重新启动', async t => {
  const { world, sessionRoot } = await setup(t); const candidates = join(world.readRoot, 'situation/candidates'); await rm(candidates, { recursive: true })
  const config = { workspaces: [world], worldId: world.worldId, agentId: 'situation', sessionId: 'failure', sessionRoot, sessionMode: 'create' as const, provider: 'test', model: 'test', adapter: new Script(), singleWriterProcess: true as const }
  await assert.rejects(createInitialSituationAgent(config)); await mkdir(candidates)
  const agent = await createInitialSituationAgent(config); await agent.dispose()
})
test('关闭主 Agent 取消局势任务并释放身份', { timeout: 10000 }, async t => {
  const { world, sessionRoot } = await setup(t)
  class Parent extends LlmAdapter { override async *stream(): AsyncIterable<StreamChunk> { yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate' as ToolCallId, name: 'delegate_initial_situation', arguments: JSON.stringify({ task: '规划' }) } }; yield { type: 'finish', reason: { kind: 'tool-calls' } } } }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Parent() }))
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve })
  class Wait extends LlmAdapter { override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> { entered(); if (!options.signal?.aborted) await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true })); yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '取消', code: 'ABORTED' } } } } }
  const config = { agentId: 'situation', sessionId: 'cancel', sessionMode: 'create' as const, sessionRoot, provider: 'test', model: 'test', adapter: new Wait() }
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true, initialSituationAgent: config })
  const pending = parent.run({ prompt: '规划' }); const rejected = assert.rejects(pending); await started; await parent.dispose(); await rejected
  const resumed = await createInitialSituationAgent({ ...config, adapter: new Script(), sessionMode: 'resume', workspaces: [world], worldId: world.worldId, singleWriterProcess: true }); await resumed.dispose()
})
