import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime, LlmError, type GenerateOptions, type StreamChunk, type LlmResolvedModelInfo, type ReasoningEffortId } from '../index'

const options: GenerateOptions = { provider: 'test', model: 'model', messages: [] }
const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }

class Adapter extends LlmAdapter {
  calls: GenerateOptions[] = []
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(request)
    yield finish
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('路由注册拒绝重复，批量失败不留下部分注册，重复清理不删除新注册', async () => {
  const runtime = new LlmRuntime(new Context())
  const adapter = new Adapter()
  const remove = runtime.registerAdapter(['test'], adapter)
  assert.throws(() => runtime.registerAdapter(['other', 'test'], adapter), /已注册/)
  assert.deepEqual(await collect(runtime.stream(options)), [finish])
  const missing = await collect(runtime.stream({ ...options, provider: 'other' }))
  assert.equal(missing[0]?.type, 'finish')
  if (missing[0]?.type === 'finish' && missing[0].reason.kind === 'error') {
    assert.equal(missing[0].reason.failure.code, 'NO_ADAPTER')
  } else assert.fail('缺失路由应返回错误结束块')
  remove()
  const removeNew = runtime.registerAdapter(['test'], new Adapter())
  remove()
  assert.deepEqual(await collect(runtime.stream(options)), [finish])
  removeNew()
})

test('解析模型默认参数，保留显式参数并拒绝不支持的推理强度', async () => {
  const effort = 'medium' as ReasoningEffortId
  class ModelAdapter extends Adapter {
    override async resolveModel(): Promise<LlmResolvedModelInfo> {
      return { provider: 'test', id: 'model', name: '模型', defaultMaxTokens: 100,
        reasoning: { efforts: [{ id: effort, name: '中等' }], defaultEffort: effort } }
    }
  }
  const adapter = new ModelAdapter()
  const runtime = new LlmRuntime(new Context())
  const remove = runtime.registerAdapter(['test'], adapter)
  try {
    await collect(runtime.stream(options))
    assert.equal(adapter.calls[0].maxTokens, 100)
    assert.equal(adapter.calls[0].reasoningEffort, effort)
    assert.equal(options.maxTokens, undefined)
    await collect(runtime.stream({ ...options, maxTokens: 12 }))
    assert.equal(adapter.calls[1].maxTokens, 12)
    const chunks = await collect(runtime.stream({ ...options, reasoningEffort: 'other' as ReasoningEffortId }))
    assert.equal(adapter.calls.length, 2)
    const end = chunks[0]
    assert.ok(end.type === 'finish' && end.reason.kind === 'error')
    assert.equal(end.reason.failure.code, 'UNSUPPORTED_REASONING_EFFORT')
  } finally { remove() }
})

test('适配器迭代失败会转换为结束块并关闭迭代器', async () => {
  let closed = 0
  class BrokenAdapter extends LlmAdapter {
    stream(): AsyncIterable<StreamChunk> {
      return { [Symbol.asyncIterator]: () => ({
        async next() { throw new LlmError('限流', 'RATE_LIMIT', { status: 429 }) },
        async return() { closed++; return { done: true, value: undefined } },
      }) }
    }
  }
  const runtime = new LlmRuntime(new Context())
  const remove = runtime.registerAdapter(['test'], new BrokenAdapter())
  try {
    const chunks = await collect(runtime.stream(options))
    assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'error', failure: { message: '限流', code: 'RATE_LIMIT', status: 429 } } }])
    assert.equal(closed, 1)
  } finally { remove() }
})

test('结束块后不继续读取，消费者提前停止会释放流，预先取消不调用适配器', async () => {
  let closed = 0
  class ClosingAdapter extends Adapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      try {
        yield { type: 'text-delta', index: 0, text: '内容' } as const
        yield finish
        assert.fail('结束块后不应继续读取')
      } finally { closed++ }
    }
  }
  const runtime = new LlmRuntime(new Context())
  const remove = runtime.registerAdapter(['test'], new ClosingAdapter())
  try {
    assert.equal((await collect(runtime.stream(options))).length, 2)
    for await (const _chunk of runtime.stream(options)) break
    assert.equal(closed, 2)
    const chunks = await collect(runtime.stream({ ...options, signal: AbortSignal.abort() }))
    assert.ok(chunks[0].type === 'finish' && chunks[0].reason.kind === 'aborted')
    assert.equal(closed, 2)
  } finally { remove() }
})

test('中间件可继续或短路，插件错误不转换为供应商失败', async () => {
  const ctx = new Context()
  const runtime = new LlmRuntime(ctx)
  const adapter = new Adapter()
  const remove = runtime.registerAdapter(['test'], adapter)
  let mode: 'continue' | 'stop' | 'fail' = 'continue'
  const off = ctx.on('llm/stream', (_request, next) => {
    if (mode === 'fail') throw new Error('插件失败')
    if (mode === 'stop') return (async function* () { yield finish })()
    return next()
  })
  try {
    await collect(runtime.stream(options))
    mode = 'stop'
    await collect(runtime.stream(options))
    assert.equal(adapter.calls.length, 1)
    mode = 'fail'
    assert.throws(() => runtime.stream(options), /插件失败/)
  } finally { off(); remove() }
})
