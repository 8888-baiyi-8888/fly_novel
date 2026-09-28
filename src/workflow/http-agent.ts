import type { AgentGenerateInput, AgentGenerateOutput, AgentPort } from './agent-port.ts'

/**
 * HttpAgent：AgentPort 的进程外 HTTP 适配器（第三方 agent 的 TS 侧接入面）。
 * 约定：服务端暴露 POST {baseUrl}/generate，接收 AgentGenerateInput（task/instruction/context/outputFormat），
 * 返回 { text: string, json?: unknown }。协议映射（第三方 agent 原生协议 ↔ 本契约）由服务端薄层完成——
 * 例如 LangChain Managed Deep Agents（LangSmith Agent Server）或 OSS deepagents 自建 Python 薄服务。
 * 非 2xx / 超时 / 响应缺 text → 抛错（节点经 runAgentTask 转 fail；重试语义由引擎接管）。
 */
export interface HttpAgentOptions {
  readonly baseUrl: string
  /** 服务端需要的鉴权头值（如 "Bearer xxx"）；缺省不发送。 */
  readonly apiKey?: string
  /** 测试注入用；缺省用全局 fetch。 */
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  /** 请求超时毫秒，默认 30000；超时以 AbortError 中止。 */
  readonly timeoutMs?: number
}

export function createHttpAgent(options: HttpAgentOptions): AgentPort {
  const { baseUrl, apiKey, timeoutMs = 30000 } = options
  const fetchImpl = options.fetchImpl ?? fetch
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey !== undefined) headers.authorization = apiKey

  return {
    async generate(input: AgentGenerateInput): Promise<AgentGenerateOutput> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/generate`, {
          method: 'POST',
          headers,
          body: JSON.stringify(input),
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`HttpAgent 服务端返回 ${res.status} ${res.statusText}`)
        const body: unknown = await res.json()
        if (typeof body !== 'object' || body === null || typeof (body as { text?: unknown }).text !== 'string') {
          throw new Error('HttpAgent 响应缺少 text 字段（应为 { text: string, json?: unknown }）')
        }
        return { text: (body as { text: string }).text, json: (body as { json?: unknown }).json }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
