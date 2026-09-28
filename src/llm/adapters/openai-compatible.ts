import { LlmAdapter } from '../adapter';
import { LlmError } from '../error';
import type { ToolCallId } from '../brand';
import type { ContentBlock, FinishReason, GenerateOptions, LlmResolvedModelInfo, StreamChunk, TokenUsage } from '../types';

/** 由应用提供连接信息；适配器不读取配置或解密凭据。 */
export interface OpenAICompatibleAdapterOptions {
  readonly baseURL: string;
  readonly apiKey: string;
  /** 可选：要求端点返回 JSON 对象（response_format: json_object）；非全部端点支持，由调用方确认。 */
  readonly responseFormat?: 'json_object';
}

type WireMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

/**
 * OpenAI Chat Completions 兼容适配器（qwen / 豆包方舟等兼容端点通用）。
 * 与 DeepSeek 适配器同构：HTTP 使用 stream: false，收到并校验完整响应后
 * 发出 block-start、增量、block-end、可选 usage 和 finish。
 */
export class OpenAICompatibleAdapter extends LlmAdapter {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly responseFormat: OpenAICompatibleAdapterOptions['responseFormat'];

  /** @param options 已解密的连接信息；地址或凭据无效时立即抛错。 */
  constructor(options: OpenAICompatibleAdapterOptions) {
    super();
    let url: URL;
    try { url = new URL(options.baseURL.trim()); }
    catch { throw new LlmError('地址必须是有效的 HTTP(S) URL', 'INVALID_CONFIG'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new LlmError('地址必须使用 HTTP(S)，且不能包含凭据、查询参数或片段', 'INVALID_CONFIG');
    }
    if (!options.apiKey.trim()) throw new LlmError('API Key 不能为空', 'INVALID_CONFIG');
    this.baseURL = url.toString().replace(/\/+$/, '');
    this.apiKey = options.apiKey.trim();
    this.responseFormat = options.responseFormat;
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: ['text'] };
  }

  /** 请求和响应校验失败时抛出 LlmError，由运行时转换为失败结束块。 */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    const messages = toWireMessages(options);
    const response = await fetch(this.baseURL + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.apiKey, 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        model: options.model, messages, stream: false,
        ...(this.responseFormat === undefined ? {} : { response_format: { type: this.responseFormat } }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
        ...(options.stop === undefined ? {} : { stop: options.stop }),
        ...(options.tools === undefined ? {} : { tools: options.tools.map(tool => ({ type: 'function', function: tool })) }),
      }),
    });
    if (!response.ok) {
      // 不输出响应正文，避免网关回显请求凭据或用户消息。
      await response.body?.cancel();
      const code = response.status === 401 || response.status === 403 ? 'AUTH'
        : response.status === 429 ? 'RATE_LIMIT' : response.status >= 500 ? 'SERVER_ERROR' : 'INVALID_REQUEST';
      throw new LlmError('请求失败，HTTP 状态码 ' + response.status, code, { status: response.status });
    }
    let body: unknown;
    try { body = await response.json(); }
    catch (error) {
      options.signal?.throwIfAborted();
      throw new LlmError('响应不是有效的 JSON', 'INVALID_RESPONSE', { cause: error });
    }
    options.signal?.throwIfAborted();
    const result = parseResponse(body);
    for (const [index, block] of result.blocks.entries()) {
      yield { type: 'block-start', index, block: block.type };
      if (block.type === 'text') yield { type: 'text-delta', index, text: block.text };
      if (block.type === 'reasoning') yield { type: 'reasoning-delta', index, text: block.text };
      if (block.type === 'tool-call') yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index, block };
    }
    if (result.usage) yield { type: 'usage', usage: result.usage };
    yield { type: 'finish', reason: result.reason };
  }
}

/** 转换统一消息；未投影的附件或不支持的扩展块明确拒绝，不静默丢弃。 */
function toWireMessages(options: GenerateOptions): WireMessage[] {
  const result: WireMessage[] = options.system === undefined ? [] : [{ role: 'system', content: options.system }];
  for (const message of options.messages) {
    const text: string[] = [];
    const reasoning: string[] = [];
    const calls: NonNullable<WireMessage['tool_calls']> = [];
    const results: WireMessage[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case 'text': text.push(block.text); break;
        case 'reasoning':
          if (message.role !== 'assistant') throw new LlmError('推理块只能属于助手消息', 'INVALID_REQUEST');
          reasoning.push(block.text); break;
        case 'tool-call':
          if (message.role !== 'assistant') throw new LlmError('工具调用只能属于助手消息', 'INVALID_REQUEST');
          calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }); break;
        case 'tool-result':
          if (message.role !== 'user') throw new LlmError('工具结果只能属于用户角色消息', 'INVALID_REQUEST');
          results.push({ role: 'tool', tool_call_id: block.toolCallId, content: block.content.map(part => {
            if (part.type !== 'text') throw new LlmError('工具结果必须先转换为文本', 'UNSUPPORTED_CONTENT');
            return part.text;
          }).join('') }); break;
        default: throw new LlmError('适配器不支持未经投影的内容块', 'UNSUPPORTED_CONTENT');
      }
    }
    if (results.length && (text.length || calls.length || reasoning.length)) {
      throw new LlmError('工具结果与普通内容必须拆成独立消息', 'INVALID_REQUEST');
    }
    if (results.length) result.push(...results);
    else result.push({ role: message.role, content: text.length ? text.join('') : null,
      ...(reasoning.length ? { reasoning_content: reasoning.join('') } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
    });
  }
  return result;
}

function invalidResponse(): never {
  throw new LlmError('响应格式无效', 'INVALID_RESPONSE');
}

/** 先校验完整响应，再向消费者发出数据块，避免部分成功后才发现格式错误。 */
function parseResponse(body: unknown): { blocks: ContentBlock[]; reason: FinishReason; usage?: TokenUsage } {
  if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0])) return invalidResponse();
  const choice = body.choices[0];
  if (!isRecord(choice.message)) return invalidResponse();
  const message = choice.message;
  const blocks: ContentBlock[] = [];
  if (message.reasoning_content !== undefined && message.reasoning_content !== null) {
    if (typeof message.reasoning_content !== 'string') return invalidResponse();
    blocks.push({ type: 'reasoning', text: message.reasoning_content });
  }
  if (message.content !== null) {
    if (typeof message.content !== 'string') return invalidResponse();
    blocks.push({ type: 'text', text: message.content });
  }
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) return invalidResponse();
    for (const call of message.tool_calls) {
      if (!isRecord(call) || typeof call.id !== 'string' || !call.id || call.type !== 'function'
        || !isRecord(call.function) || typeof call.function.name !== 'string' || !call.function.name
        || typeof call.function.arguments !== 'string') return invalidResponse();
      blocks.push({ type: 'tool-call', id: call.id as ToolCallId, name: call.function.name, arguments: call.function.arguments });
    }
  }
  let reason: FinishReason;
  switch (choice.finish_reason) {
    case 'stop': reason = { kind: 'stop' }; break;
    case 'length': reason = { kind: 'max-tokens' }; break;
    case 'tool_calls': reason = { kind: 'tool-calls' }; break;
    case 'content_filter': throw new LlmError('模型未能完成响应：内容被过滤', 'PROVIDER_ERROR');
    default: return invalidResponse();
  }
  if (choice.finish_reason === 'tool_calls' && !blocks.some(block => block.type === 'tool-call')) return invalidResponse();
  const usage = body.usage === undefined ? undefined : parseUsage(body.usage);
  return { blocks, reason, ...(usage === undefined ? {} : { usage }) };
}

function parseUsage(value: unknown): TokenUsage {
  if (!isRecord(value) || !isCount(value.prompt_tokens) || !isCount(value.completion_tokens)) return invalidResponse();
  const cached = value.prompt_cache_hit_tokens ?? 0;
  if (!isCount(cached) || cached > value.prompt_tokens) return invalidResponse();
  const total = value.prompt_tokens + value.completion_tokens;
  return { inputTokens: value.prompt_tokens - cached, outputTokens: value.completion_tokens,
    ...(value.prompt_cache_hit_tokens === undefined ? {} : { cacheReadTokens: cached }),
    ...(Number.isSafeInteger(total) && (value.total_tokens === undefined || value.total_tokens === total) ? { totalTokens: total } : {}),
  };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
