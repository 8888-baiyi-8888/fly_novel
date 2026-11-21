import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import type { Agent } from '@fly-novel/agents'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { DiscussionService, type DiscussionTargetAdapter } from '../../world-init/discussion/service.js'
import { withFileDiscussionAdapter } from '../../world-init/discussion/file-adapter.js'

type Action = (options: GenerateOptions) => { name: string; args: object } | { text: string } | { fail: true } | { wait: true }
class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly actions: Action[]) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const action = this.actions.shift(); assert.ok(action, '模型替身脚本耗尽')
    const result = action(options)
    if ('wait' in result) {
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) reject(options.signal.reason)
        else options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      })
      return
    }
    if ('fail' in result) { yield { type: 'finish', reason: { kind: 'error', failure: { message: '模拟失败', code: 'PROVIDER_ERROR' } } }; return }
    if ('text' in result) { yield { type: 'block-end', index: 0, block: { type: 'text', text: result.text } }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-${this.actions.length}` as ToolCallId, name: result.name, arguments: JSON.stringify(result.args) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
const read: Action = () => ({ name: 'discussion_read', args: {} })
const say = (text: string): Action => () => ({ text })
const prepare = (content: string, version?: string): Action => () => ({ name: 'discussion_prepare', args: { content, summary: '用户要求', ...(version ? { version } : {}) } })
function versionFromLastRead(options: GenerateOptions): string {
  const blocks = options.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
  const last = blocks.at(-1); assert.ok(last && last.type === 'tool-result' && !last.isError)
  const text = last.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text')
  const data: unknown = JSON.parse(text.text)
  assert.ok(data && typeof data === 'object' && 'candidate' in data && data.candidate && typeof data.candidate === 'object' && 'version' in data.candidate)
  const version = data.candidate.version
  if (typeof version !== 'string') throw new Error('候选版本无效')
  return version
}

test('多轮问答、候选修改、切换和重启保留各自状态', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'discussion-e2e-'))); t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['world/main', 'world/confirmed', 'world/catalog', 'world/map/places', 'world/map/connections', 'pending/discussions', 'pending/candidates', 'sessions']) await mkdir(join(root, dir), { recursive: true })
  const view = join(root, 'world'); const sessions = join(root, 'sessions')
  await writeFile(join(view, 'main/city.md'), '城门开放'); await writeFile(join(view, 'main/sect.md'), '宗门原文')
  const world = { worldId: 'e2e-world', readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [{ agentId: 'map', writableRoot: join(view, 'map') }] }
  const context = new Context(); const backend = context.plugin(LocalFileSystem, { cwd: root }); await backend
  const base: DiscussionTargetAdapter = { async read() { throw new Error('未支持') }, async validate() { throw new Error('未支持') },
    async validateStored() { throw new Error('未支持') }, async assertNoLegacyCandidate() { throw new Error('未支持') } }
  const service = await DiscussionService.open({ worldId: world.worldId, root: join(root, 'pending'), worldRoots: [view], fs: context.fs,
    adapter: withFileDiscussionAdapter(base, world, context.fs), singleWriterProcess: true })
  const city = await service.createDiscussion({ kind: 'file', ownerAgentId: 'main', path: 'main/city.md' }, 'city')
  const sect = await service.createDiscussion({ kind: 'file', ownerAgentId: 'main', path: 'main/sect.md' }, 'sect')
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const adapter = new ScriptedAdapter([
    read, say('只是讨论'),
    read, prepare('城门夜间关闭'), say('候选已保存'),
    read, options => ({ name: 'discussion_prepare', args: { content: '城门夜间关闭，商队例外', summary: '增加例外', version: versionFromLastRead(options) } }), say('候选已更新'),
    read, prepare('宗门候选'), say('宗门候选已保存'),
    read, say('已恢复城门讨论'),
    () => ({ name: 'delegate_map', args: { task: '分析城门' } }), options => {
      const blocks = options.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
      const last = blocks.at(-1); assert.ok(last && last.type === 'tool-result' && last.isError)
      return { text: '子任务失败，候选保留' }
    },
    () => ({ fail: true }),
    () => { enter(); return { wait: true } },
  ])
  const child = new ScriptedAdapter([() => ({ fail: true })])
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter }))
  const open = (discussionId: string, sessionId: string, sessionMode: 'create' | 'resume') => createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined,
    { singleWriterProcess: true, discussion: { firstVersionComplete: true, binding: { service, discussionId } }, mainSession: { sessionRoot: sessions, sessionId, sessionMode },
      mapAgent: { agentId: 'map', sessionRoot: sessions, sessionId: `map-${sessionId}`, sessionMode: 'create', provider: 'test', model: 'test', adapter: child } })
  let agent: Agent | undefined
  try {
    agent = await open(city.id, 'city', 'create')
    await agent.run({ prompt: '关闭城门有什么好处？' }); assert.equal((await service.listCandidates(city.id)).length, 0)
    await agent.run({ prompt: '改为夜间关闭' }); await agent.run({ prompt: '商队例外' })
    await agent.dispose()
    agent = await open(sect.id, 'sect', 'create'); await agent.run({ prompt: '修改宗门' }); await agent.dispose()
    agent = await open(city.id, 'city', 'resume')
    await agent.run({ prompt: '继续城门讨论' })
    await agent.run({ prompt: '请地图 Agent 分析' })
    await assert.rejects(agent.run({ prompt: '模拟失败' }))
    const running = agent.run({ prompt: '取消本轮' }); const rejected = assert.rejects(running)
    await entered; agent.cancel(); await rejected
    await agent.dispose()
    const cityCandidate = (await service.listCandidates(city.id))[0]!
    assert.equal(cityCandidate.value.content, '城门夜间关闭，商队例外')
    assert.equal((await service.listCandidates(sect.id))[0]!.value.content, '宗门候选')
    assert.equal(await readFile(join(view, 'main/city.md'), 'utf8'), '城门开放')
    await service.abandonCandidate(city.id, cityCandidate.value.id, cityCandidate.version)
    assert.equal((await service.readCandidate(cityCandidate.value.id)).value.status, 'abandoned')
  } finally { await agent?.dispose(); await service.close(); await backend.dispose() }
})
