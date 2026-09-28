import type { AgentGenerateInput, AgentGenerateOutput, AgentPort } from './agent-port.ts'

/**
 * OpenAICompatibleAgent：AgentPort 的 OpenAI 兼容协议适配器。
 * 适用端点：阿里云 MaaS（maas.aliyuncs.com/compatible-mode/v1）、DashScope compatible-mode、
 * DeepSeek / OpenAI 等 /v1/chat/completions 形态（baseUrl 需含版本前缀，如 .../compatible-mode/v1）。
 *
 * 映射（第三方原生协议 ↔ 本契约）：
 * - instruction → system 消息；context → user 消息；outputFormat='json' 且 jsonMode=true →
 *   response_format={type:'json_object'}（兼容端点支持时；不支持则置 jsonMode=false，
 *   靠 prompt 要求 JSON + 节点侧 jsonFromOutput 解析兜底）。
 * - 响应取 choices[0].message.content 为 text；outputFormat='json' 时顺带尝试解析为 json。
 * - 非 2xx / 超时 / 缺 content → 抛错（节点经 runAgentTask 转 fail；重试语义由引擎接管）。
 */
export interface OpenAICompatibleAgentOptions {
  /** 已含版本前缀的端点根，如 https://xxx.maas.aliyuncs.com/compatible-mode/v1。 */
  readonly baseUrl: string
  /** 裸 API Key（适配器自动加 `Bearer ` 前缀），勿含空格。 */
  readonly apiKey: string
  /** 模型名（MaaS 专属实例/服务部署名由服务方提供）。 */
  readonly model: string
  readonly temperature?: number
  /** 输出 token 上限（max_tokens）。缺省不传（用端点默认）；Dispatch 等长 JSON 被截断时显式调大。 */
  readonly maxTokens?: number
  /** 是否请求 response_format=json_object；默认 true，端点不支持时置 false。 */
  readonly jsonMode?: boolean
  /** 请求超时毫秒，默认 60000（LLM 生成通常慢于普通 HTTP）。 */
  readonly timeoutMs?: number
  /** 测试注入用；缺省用全局 fetch。 */
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  /** qwen3 系列思考开关；默认 false（prompt 已给全结构，思考链只会吃 maxTokens 导致 content 被截断为空）。 */
  readonly enableThinking?: boolean
}

/**
 * 读取 OpenAI SSE 流（`data: {...}` 行，`choices[0].delta.content` 累积，`data: [DONE]` 结束）。
 * 流式让长生成（如 write 正文）保持连接活跃，避免网关对"长时间无响应"的非流式请求主动断开。
 */
async function readSseContent(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
  }
  let content = ''
  for (const line of buffer.split(/\r?\n/)) {
    const s = line.trim()
    if (!s.startsWith('data:')) continue
    const payload = s.slice(5).trim()
    if (payload === '[DONE]') break
    try {
      const evt = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] }
      const delta = evt.choices?.[0]?.delta?.content
      if (typeof delta === 'string') content += delta
    } catch {
      /* keepalive/注释行忽略 */
    }
  }
  return content
}

export function createOpenAICompatibleAgent(options: OpenAICompatibleAgentOptions): AgentPort {
  const { baseUrl, apiKey, model, temperature, maxTokens, jsonMode = true, timeoutMs = 60000, enableThinking = false } = options
  const fetchImpl = options.fetchImpl ?? fetch

  return {
    async generate(input: AgentGenerateInput): Promise<AgentGenerateOutput> {
      const messages: readonly { role: 'system' | 'user'; content: string }[] = [
        { role: 'system', content: input.instruction },
        { role: 'user', content: input.context },
      ]
      const body: Record<string, unknown> = { model, messages, stream: true, enable_thinking: enableThinking }
      if (temperature !== undefined) body.temperature = temperature
      if (maxTokens !== undefined) body.max_tokens = maxTokens
      if (input.outputFormat === 'json' && jsonMode) body.response_format = { type: 'json_object' }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`OpenAI 兼容端点返回 ${res.status} ${res.statusText}`)
        // SSE 流式路径（write 等长生成走这里，连接边收边活跃；按 content-type 判定）；非流响应退回 json()。
        const contentType = res.headers.get('content-type') ?? ''
        const content =
          contentType.includes('event-stream') && res.body !== null
            ? await readSseContent(res)
            : ((await res.json()) as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content
        if (typeof content !== 'string' || content === '') {
          throw new Error('OpenAI 兼容端点响应缺少 choices[0].（message/delta）content')
        }
        const text = content.trim()
        if (input.outputFormat === 'json') {
          try {
            return { text, json: JSON.parse(text) as unknown }
          } catch {
            return { text }
          }
        }
        return { text }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
