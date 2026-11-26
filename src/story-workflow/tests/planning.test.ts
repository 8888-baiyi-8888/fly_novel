import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentInstance } from '@fly-novel/agents'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { createStoryPlan, readStoryPlan } from '../../app/story-workflow.js'
import { PlanStore } from '../store.js'

class FixedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly response: string) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.response } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const input = { task: '规划城防与商贸', facts: ['城门夜间关闭'], directions: ['城防与商贸可能趋紧'] }

test('导演依据固定资料生成事件，程序保存独立身份并重读', async t => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new FixedAdapter('{"kind":"planned","events":["商队夜间抵达","处理货物问题"]}')
  const options = { root, protectedRoots: [], provider: 'test', model: 'test', adapter }
  const record = await createStoryPlan(options, input)
  assert.equal(record.outcome.kind, 'planned')
  if (record.outcome.kind !== 'planned') throw new Error('规划应有事件')
  assert.equal(new Set([record.id, ...record.outcome.events.map(event => event.id)]).size, 3)
  assert.deepEqual(await readStoryPlan(options, record.id), record)
  const request = JSON.stringify(adapter.requests[0]?.messages)
  assert.match(request, /城门夜间关闭/)
  assert.match(request, /城防与商贸可能趋紧/)
  assert.match(request, /计划不是已经发生的事实/)
  await assert.rejects((await PlanStore.open(root, [])).save(record), /规划保存失败/)
  assert.deepEqual(await readStoryPlan(options, record.id), record)
})

test('无可推进事件有原因，与无效空计划区分', async t => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { root, protectedRoots: [], provider: 'test', model: 'test', adapter: new FixedAdapter('{"kind":"no_events","reason":"等待商队消息"}') }
  const record = await createStoryPlan(options, input)
  assert.deepEqual((await readStoryPlan(options, record.id)).outcome, { kind: 'no_events', reason: '等待商队消息' })
  await assert.rejects(createStoryPlan({ ...options, adapter: new FixedAdapter('{"kind":"planned","events":[]}') }, input))
})

test('未知版本、重复键和损坏记录被拒绝且原文件保留', async t => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { root, protectedRoots: [], provider: 'test', model: 'test', adapter: new FixedAdapter('{"kind":"planned","events":["交涉"]}') }
  const record = await createStoryPlan(options, input)
  const path = join(root, `${record.id}.json`)
  const original = await readFile(path, 'utf8')
  for (const invalid of [original.replace('"formatVersion": 1', '"formatVersion": 2'), original.replace('"formatVersion": 1', '"formatVersion": 1, "formatVersion": 1'), '{']) {
    await writeFile(path, invalid)
    await assert.rejects(readStoryPlan(options, record.id))
    assert.equal(await readFile(path, 'utf8'), invalid)
  }
})

test('模型失败传播并释放导演，记录目录隔离失败时不调用模型', async t => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  class FailingAdapter extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: '模型不可用' } } }
    }
  }
  const disposal = t.mock.method(AgentInstance.prototype, 'dispose')
  const options = { root, protectedRoots: [], provider: 'test', model: 'test', adapter: new FailingAdapter() }
  await assert.rejects(createStoryPlan(options, input), /模型不可用/)
  assert.equal(disposal.mock.callCount(), 1)
  const fixed = new FixedAdapter('{"kind":"planned","events":["交涉"]}')
  await assert.rejects(createStoryPlan({ ...options, protectedRoots: [root], adapter: fixed }, input), /重叠/)
  assert.equal(fixed.requests.length, 0)
})

test('取消规划后释放导演且不保存结果', async t => {
  const root = await mkdtemp(join(tmpdir(), 'story-plan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  class WaitingAdapter extends LlmAdapter {
    private notify!: () => void
    readonly started = new Promise<void>(resolve => { this.notify = resolve })
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.notify()
      await new Promise<void>(resolve => { if (options.signal?.aborted) resolve(); else options.signal?.addEventListener('abort', () => resolve(), { once: true }) })
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: '已取消' } } }
    }
  }
  const adapter = new WaitingAdapter()
  const disposal = t.mock.method(AgentInstance.prototype, 'dispose')
  const controller = new AbortController()
  const running = createStoryPlan({ root, protectedRoots: [], provider: 'test', model: 'test', adapter }, input, controller.signal)
  await adapter.started
  controller.abort()
  await assert.rejects(running)
  assert.equal(disposal.mock.callCount(), 1)
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(root), [])
})
