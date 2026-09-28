import type { Step } from '../novel/types'

/** workflow 节点消费的 agent 任务标识：与章节流七步一一对应。 */
export type AgentTask = Step

export interface AgentGenerateInput {
  readonly task: AgentTask
  /** 任务指令（节点 prompt 主体；真实 agent 作为 system 段）。 */
  readonly instruction: string
  /** 已序列化的上下文（前序产物 / 知识快照；真实 agent 作为 user 段）。 */
  readonly context: string
  /** 期望输出为 JSON 结构时传 'json'，节点按 json 字段取解析结果。 */
  readonly outputFormat?: 'text' | 'json'
}

export interface AgentGenerateOutput {
  readonly text: string
  /** outputFormat='json' 时解析后的对象；解析失败由节点回退处理。 */
  readonly json?: unknown
}

/**
 * workflow 消费的 agent 生成能力端口（Port）。
 *
 * 现状：真实 agent（harness/agent-loop）尚未就绪，由 StubAgent 实现本端口驱动 workflow 先行开发；
 * 未来：A 的 agent 闭环就绪后实现同一端口注入（内部可复用 llm 运行时与 ReactLoopAgent），
 * workflow 引擎与参考节点无需任何改动。此即"预留 agent 位置"的契约面。
 */
export interface AgentPort {
  readonly generate: (input: AgentGenerateInput) => Promise<AgentGenerateOutput>
}
