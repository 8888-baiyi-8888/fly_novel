import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { DeepSeekAdapter } from '../adapters/deepseek';
import { LlmRuntime } from '../runtime';
import type { GenerateOptions, StreamChunk } from '../types';
import type { MessageId, ReasoningEffortId, ToolCallId } from '../brand';

const connection = { baseURL: 'https://example.test/v1/', apiKey: 'fake-key' };
const request: GenerateOptions = { provider: 'deepseek', model: 'test-model', messages: [] };
const response = (content: unknown, finish_reason = 'stop', extra = {}) => new Response(JSON.stringify({
  choices: [{ message: { content, ...extra }, finish_reason }],
  usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 4, completion_tokens: 3, total_tokens: 13 },
}));

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = [];
  for await (const chunk of chunks) result.push(chunk);
  return result;
}

test('DeepSeek 通过运行时接收统一参数并输出文本、推理、统计和结束块', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://example.test/v1/chat/completions');
    assert.equal(init.signal, controller.signal);
    assert.deepEqual(init.headers, { Authorization: 'Bearer fake-key', 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(String(init.body)), {
      model: 'test-model', messages: [{ role: 'system', content: '系统' }, { role: 'user', content: '问题' }],
      stream: false, thinking: { type: 'enabled' }, reasoning_effort: 'high', temperature: 0, max_tokens: 50, stop: ['结束'],
    });
    return response('回答', 'length', { reasoning_content: '思考' });
  });
  const runtime = new LlmRuntime(new Context());
  const remove = runtime.registerAdapter(['deepseek'], new DeepSeekAdapter({ ...connection, thinking: 'enabled' }));
  try {
    const chunks = await collect(runtime.stream({ ...request, system: '系统', signal: controller.signal,
      reasoningEffort: 'high' as ReasoningEffortId, temperature: 0, maxTokens: 50, stop: ['结束'],
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

test('DeepSeek 转换工具定义、历史调用和结果，并保留原始参数字符串', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'lookup', description: '查询', parameters: { type: 'object' } } }]);
    assert.equal(body.messages[0].tool_calls[0].function.arguments, '{"query":"test"}');
    assert.deepEqual(body.messages[1], { role: 'tool', tool_call_id: 'call', content: '结果' });
    return response(null, 'tool_calls', { tool_calls: [{ id: 'next', type: 'function', function: { name: 'lookup', arguments: '{' } }] });
  });
  const chunks = await collect(new DeepSeekAdapter(connection).stream({ ...request,
    tools: [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
    messages: [
      { id: 'assistant' as MessageId, role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'test-model' },
        content: [{ type: 'tool-call', id: 'call' as ToolCallId, name: 'lookup', arguments: '{"query":"test"}' }] },
      { id: 'result' as MessageId, role: 'user', source: { kind: 'tool', callId: 'call' as ToolCallId },
        content: [{ type: 'tool-result', toolCallId: 'call' as ToolCallId, content: [{ type: 'text', text: '结果' }] }] },
    ],
  }));
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
  assert.ok(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.arguments === '{'));
});

test('DeepSeek 将 HTTP 失败和无效响应交给运行时归一化，不输出响应正文', async t => {
  let mode = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 0) return new Response('fake-key must stay private', { status: 429 });
    if (mode === 1) return response(123);
    if (mode === 2) return response('text', 'unknown');
    return new Response('invalid json');
  });
  const runtime = new LlmRuntime(new Context());
  const remove = runtime.registerAdapter(['deepseek'], new DeepSeekAdapter(connection));
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

test('DeepSeek 区分空文本与无文本，预先取消不发送请求', async t => {
  let content: string | null = '';
  const fetch = t.mock.method(globalThis, 'fetch', async () => response(content));
  const adapter = new DeepSeekAdapter(connection);
  assert.ok((await collect(adapter.stream(request))).some(chunk => chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text === ''));
  content = null;
  assert.ok(!(await collect(adapter.stream(request))).some(chunk => chunk.type === 'block-end'));
  await assert.rejects(collect(adapter.stream({ ...request, signal: AbortSignal.abort() })), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 2);
  assert.throws(() => new DeepSeekAdapter({ ...connection, baseURL: 'file:///key' }), /HTTP/);
});
