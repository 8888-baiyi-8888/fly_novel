import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { OpenAICompatibleAdapter } from '../adapters/openai-compatible';
import { LlmRuntime } from '../runtime';
import type { GenerateOptions, StreamChunk } from '../types';
import type { MessageId } from '../brand';

const connection = { baseURL: 'https://example.test/v1/', apiKey: 'fake-key' };
const request: GenerateOptions = { provider: 'qwen', model: 'test-model', messages: [] };
const response = (content: unknown, finish_reason = 'stop', extra = {}) => new Response(JSON.stringify({
  choices: [{ message: { content, ...extra }, finish_reason }],
  usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 4, completion_tokens: 3, total_tokens: 13 },
}));

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = [];
  for await (const chunk of chunks) result.push(chunk);
  return result;
}

test('OpenAI 兼容适配器通过运行时输出文本、推理、统计和结束块', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://example.test/v1/chat/completions');
    assert.equal(init.signal, controller.signal);
    assert.deepEqual(init.headers, { Authorization: 'Bearer fake-key', 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(String(init.body)), {
      model: 'test-model', messages: [{ role: 'system', content: '系统' }, { role: 'user', content: '问题' }],
      stream: false, response_format: { type: 'json_object' }, temperature: 0, max_tokens: 50, stop: ['结束'],
    });
    return response('回答', 'length', { reasoning_content: '思考' });
  });
  const runtime = new LlmRuntime(new Context());
  const remove = runtime.registerAdapter(['qwen'], new OpenAICompatibleAdapter({ ...connection, responseFormat: 'json_object' }));
  try {
    const chunks = await collect(runtime.stream({ ...request, system: '系统', signal: controller.signal,
      temperature: 0, maxTokens: 50, stop: ['结束'],
      messages: [{ id: 'message' as MessageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '问题' }] }],
    }));
    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, block: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '思考' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '思考' } },
      { type: 'block-start', index: 1, block: 'text' },
      { type: 'text-delta', index: 1, text: '回答' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '回答' } },
      { type: 'usage', usage: { inputTokens: 6, cacheReadTokens: 4, outputTokens: 3, totalTokens: 13 } },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]);
  } finally { remove(); }
});

test('OpenAI 兼容适配器将 HTTP 失败和无效响应交给运行时归一化，不输出响应正文', async t => {
  let mode = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 0) return new Response('fake-key must stay private', { status: 429 });
    if (mode === 1) return response(123);
    if (mode === 2) return response('text', 'unknown');
    return new Response('invalid json');
  });
  const runtime = new LlmRuntime(new Context());
  const remove = runtime.registerAdapter(['qwen'], new OpenAICompatibleAdapter(connection));
  try {
    for (mode = 0; mode < 4; mode++) {
      const chunks = await collect(runtime.stream(request));
      assert.equal(chunks.length, 1);
      const chunk = chunks[0];
      assert.ok(chunk.type === 'finish' && chunk.reason.kind === 'error');
      assert.equal(chunk.reason.failure.code, mode === 0 ? 'RATE_LIMIT' : 'INVALID_RESPONSE');
      assert.ok(!JSON.stringify(chunks).includes('fake-key'));
    }
  } finally { remove(); }
});

test('OpenAI 兼容适配器区分空文本与无文本，拒绝非法地址', async t => {
  let content: string | null = '';
  const fetch = t.mock.method(globalThis, 'fetch', async () => response(content));
  const adapter = new OpenAICompatibleAdapter(connection);
  assert.ok((await collect(adapter.stream(request))).some(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text === ''));
  content = null;
  assert.ok(!(await collect(adapter.stream(request))).some(chunk => chunk.type === 'block-end'));
  await assert.rejects(collect(adapter.stream({ ...request, signal: AbortSignal.abort() })), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 2);
  assert.throws(() => new OpenAICompatibleAdapter({ ...connection, baseURL: 'file:///key' }), /HTTP/);
});
