import type { AgentGenerateOutput, AgentPort, AgentTask } from './agent-port.ts'

/** 一条 stub 响应：给出 json（自动序列化为 text）或纯 text，二选一。 */
export interface StubResponse {
  readonly text?: string
  readonly json?: unknown
}

/**
 * 匹配规则：task 精确匹配；match 为 instruction 包含的子串（同一任务的分支）。
 * responses 按调用次数轮换，用尽后固定最后一个——重试场景（如先产出违规
 * Dispatch 触发闸门，再产出合规）无需改动规则表即可复现。
 */
export interface StubRule {
  readonly task?: AgentTask
  readonly match?: string
  readonly responses: readonly [StubResponse, ...StubResponse[]]
}

/**
 * 确定性模拟 agent：按规则表返回预设响应，可编程、可重放、可计数。
 * 无匹配规则时抛错（视为 agent 调用失败，节点转 fail），便于测试失败路径。
 */
export class StubAgent implements AgentPort {
  private readonly counters = new Map<string, number>()

  constructor(private readonly rules: readonly StubRule[]) {}

  async generate(input: Parameters<AgentPort['generate']>[0]): Promise<AgentGenerateOutput> {
    const rule = this.rules.find(
      (r) =>
        (r.task === undefined || r.task === input.task) &&
        (r.match === undefined || input.instruction.includes(r.match)),
    )
    if (rule === undefined) {
      throw new Error(`StubAgent：无匹配规则 task=${input.task}`)
    }
    const key = `${input.task}\u0000${rule.match ?? ''}`
    const n = this.counters.get(key) ?? 0
    this.counters.set(key, n + 1)
    const response = rule.responses[Math.min(n, rule.responses.length - 1)]
    if (response.json !== undefined) {
      return { text: JSON.stringify(response.json), json: response.json }
    }
    return { text: response.text ?? '' }
  }

  /** 已调用次数（可按任务过滤），供测试断言（如断点续跑未重跑前序步骤）。 */
  count(task?: AgentTask): number {
    if (task === undefined) {
      return [...this.counters.values()].reduce((sum, n) => sum + n, 0)
    }
    let total = 0
    for (const [key, n] of this.counters) {
      if (key.startsWith(`${task}\u0000`)) total += n
    }
    return total
  }
}
