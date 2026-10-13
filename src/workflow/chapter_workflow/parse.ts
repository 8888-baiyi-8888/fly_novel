import type { AgentGenerateInput, AgentGenerateOutput, AgentPort } from '../agent-port.ts'
import type { Dispatch, RuntimeDelta, SceneSheet, Simulation } from '../../novel/types'

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 从 agent 输出取 JSON 值：优先 json 字段，否则解析 text；解析失败返回 undefined。 */
export function jsonFromOutput(out: AgentGenerateOutput): unknown {
  if (out.json !== undefined) return out.json
  const t = out.text.trim()
  if (t === '') return undefined
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

/** agent 调用安全封装：抛错（LLM/stub 失败）→ 转 fail 原因，不让异常逃出节点。 */
export async function runAgentTask(
  agent: AgentPort,
  input: AgentGenerateInput,
): Promise<{ readonly ok: true; readonly output: AgentGenerateOutput } | { readonly ok: false; readonly reason: string }> {
  try {
    return { ok: true, output: await agent.generate(input) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Dispatch 形状校验：闸门运行前必须保证 hookDirectives 五个数组字段存在。 */
export function parseDispatch(out: AgentGenerateOutput): Dispatch | undefined {
  const v = jsonFromOutput(out)
  if (!isRecord(v)) return undefined
  const hd = v.hookDirectives
  if (!isRecord(hd)) return undefined
  if (
    typeof v.chapter !== 'number' ||
    typeof v.goal !== 'string' ||
    !Array.isArray(v.castPlan) ||
    !Array.isArray(v.threadPlan) ||
    !Array.isArray(v.styleNotes) ||
    !isRecord(v.budget)
  ) {
    return undefined
  }
  for (const key of ['open', 'advance', 'resolve', 'defer', 'mention'] as const) {
    if (!Array.isArray(hd[key])) return undefined
  }
  return v as unknown as Dispatch
}

/**
 * Dispatch 形状校验失败诊断（与 parseDispatch 同一判定顺序）：
 * 供节点 retry reason / 调试用，把"哪里不合法"说清楚（真实 agent 接入后最常见的问题来源）。
 */
export function describeDispatchFailure(out: AgentGenerateOutput): string {
  const v = jsonFromOutput(out)
  if (v === undefined) {
    const preview = out.text.trim().slice(0, 120)
    return `text 不是合法 JSON（预览：${preview === '' ? '(空输出)' : preview}）`
  }
  if (!isRecord(v)) return 'JSON 顶层不是对象'
  const problems: string[] = []
  if (typeof v.chapter !== 'number') problems.push('chapter(number)')
  if (typeof v.goal !== 'string') problems.push('goal(string)')
  if (!Array.isArray(v.castPlan)) problems.push('castPlan(array)')
  if (!Array.isArray(v.threadPlan)) problems.push('threadPlan(array)')
  if (!Array.isArray(v.styleNotes)) problems.push('styleNotes(array)')
  if (!isRecord(v.budget)) problems.push('budget(object)')
  const hd = v.hookDirectives
  if (!isRecord(hd)) {
    problems.push('hookDirectives(object)')
  } else {
    for (const key of ['open', 'advance', 'resolve', 'defer', 'mention'] as const) {
      if (!Array.isArray(hd[key])) problems.push(`hookDirectives.${key}(array)`)
    }
  }
  if (problems.length === 0) return '形状不满足 Dispatch 契约（字段类型不符）'
  const rawPreview = JSON.stringify(v).slice(0, 300)
  return `缺/错字段：${problems.join('、')}（原始 JSON 预览：${rawPreview}）`
}

/** Simulation 数组形状校验：至少一条且每条有角色名。 */
export function parseSimulations(out: AgentGenerateOutput): readonly Simulation[] | undefined {
  const v = jsonFromOutput(out)
  if (!Array.isArray(v) || v.length === 0) return undefined
  if (!v.every((s) => isRecord(s) && typeof s.character === 'string')) return undefined
  return v as unknown as readonly Simulation[]
}

/** SceneSheet 形状校验：writingPlan + scenes 数组。 */
export function parseSceneSheet(out: AgentGenerateOutput): SceneSheet | undefined {
  const v = jsonFromOutput(out)
  if (!isRecord(v) || typeof v.writingPlan !== 'string' || !Array.isArray(v.scenes)) return undefined
  return v as unknown as SceneSheet
}

/** RuntimeDelta 形状校验：facts / hookOps / stateChanges 三部分。 */
export function parseRuntimeDelta(out: AgentGenerateOutput): RuntimeDelta | undefined {
  const v = jsonFromOutput(out)
  if (!isRecord(v) || !Array.isArray(v.facts) || !Array.isArray(v.hookOps) || !isRecord(v.stateChanges)) return undefined
  return v as unknown as RuntimeDelta
}
