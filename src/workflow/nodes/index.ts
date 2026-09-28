import type { BookRuntime } from '../../novel/runtime'
import type { AgentPort } from '../agent-port.ts'
import type { StepNode } from '../types.ts'
import { createAuditNode } from './audit.ts'
import { createCensorNode } from './censor.ts'
import { createDirectNode, type DirectNodeDeps } from './direct.ts'
import { createMergeNode, minimalWeavePlan } from './merge.ts'
import { createSettleNode, type SettleNodeDeps } from './settle.ts'
import { createSimulateNode } from './simulate.ts'
import { createWriteNode } from './write.ts'

/** 组装章节流 7 节点所需的确定性依赖：书运行时（小说流交付的确定性状态面，FakeBookRuntime 可模拟）。 */
export interface ChapterNodesDeps {
  readonly runtime: BookRuntime
}

/**
 * 组装章节流 7 节点（参考实现）：LLM 型节点经 AgentPort 生成（当前注入 StubAgent 即可端到端运行），
 * merge 的 weavePlan 用确定性占位（TimelineManager 位置），direct 实时渲染债务表并接入 §5.3 校验闸门，
 * settle 产出 delta 后回写 BookRuntime（§11.3 纯函数部分）。
 * B 实现真实节点时替换对应工厂即可，引擎与契约不变。
 */
export function buildChapterNodes(agent: AgentPort, deps: ChapterNodesDeps): readonly StepNode[] {
  const directDeps: DirectNodeDeps = deps
  const settleDeps: SettleNodeDeps = deps
  return [
    createDirectNode(agent, directDeps),
    createSimulateNode(agent),
    createMergeNode(agent),
    createWriteNode(agent),
    createAuditNode(agent),
    createCensorNode(agent),
    createSettleNode(agent, settleDeps),
  ]
}

export { createDirectNode } from './direct.ts'
export type { DirectNodeDeps } from './direct.ts'
export { createSimulateNode } from './simulate.ts'
export { createMergeNode, minimalWeavePlan } from './merge.ts'
export { createWriteNode, WRITE_INSTRUCTION, WRITE_BANS, WRITE_STYLE_GUIDE } from './write.ts'
export { createAuditNode } from './audit.ts'
export { createCensorNode } from './censor.ts'
export { createSettleNode } from './settle.ts'
export type { SettleNodeDeps } from './settle.ts'

// 指令常量统一出口（agent 对接方可直接 import，无需翻各节点文件）：
// 每个 LLM 型节点的 prompt 唯一事实来源，改动前先看 docs/modules/workflow-agent.md。
export { DIRECT_INSTRUCTION } from './direct.ts'
export { SIMULATE_INSTRUCTION } from './simulate.ts'
export { MERGE_INSTRUCTION } from './merge.ts'
export { AUDIT_INSTRUCTION } from './audit.ts'
export { CENSOR_INSTRUCTION } from './censor.ts'
export { SETTLE_INSTRUCTION } from './settle.ts'
