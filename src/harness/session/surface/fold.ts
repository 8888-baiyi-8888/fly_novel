import type { Message } from '@fly-novel/llm'
import { SessionLogOffset, SessionSeq } from '../types/index.ts'
import type { SessionEvent, SurfaceOp } from '../types/index.ts'
import type { SessionMessageProjection, SurfaceFoldReplacement, SurfaceFoldResult } from './types.ts'
import { MESSAGE_PROJECTION_EVENT_TYPES } from '../types/known-events.ts'
import { assertSourceEventReferences, validateSurfaceMetadata } from './metadata.ts'

/** 完整折叠与增量折叠共用的可变状态。 */
interface SurfaceFoldState {
  nodes: SessionSeq[]
  replaceGeneration: number
  contentGeneration: number
  projectedMessages: Map<SessionSeq, Message>
  projections: Set<SessionMessageProjection>
}

/** 已校验但尚未修改折叠状态的替换状态转换。 */
interface SurfaceReplacePlan extends SurfaceFoldReplacement {
  kind: 'replace'
  startIdx: number
  endIdx: number
}

/** 已校验但尚未修改折叠状态的一次消息视图状态转换。 */
export type SurfacePlan =
  | { kind: 'append'; seq: SessionSeq }
  | SurfaceReplacePlan
  | { kind: 'project'; projection: SessionMessageProjection; messages: ReadonlyMap<SessionSeq, Message> }

/** 创建空的消息视图折叠状态。 */
export function createFoldState(): SurfaceFoldState {
  return { nodes: [], replaceGeneration: 0, contentGeneration: 0, projectedMessages: new Map(), projections: new Set() }
}

/** 定位一次替换的范围，不修改当前折叠状态。 */
function replacementRange(
  state: SurfaceFoldState,
  op: Extract<SurfaceOp, { op: 'replace' }>,
): Pick<SurfaceReplacePlan, 'startIdx' | 'endIdx' | 'shadowedSeqs'> {
  const startIdx = state.nodes.indexOf(op.startSeq)
  if (startIdx === -1) {
    throw new Error(`消息视图替换：视图中不存在起始序号 ${op.startSeq}`)
  }
  const endIdx = state.nodes.indexOf(op.endSeq)
  if (endIdx === -1) {
    throw new Error(`消息视图替换：视图中不存在结束序号 ${op.endSeq}`)
  }
  if (startIdx > endIdx) {
    throw new Error(`消息视图替换：起始序号 ${op.startSeq}（索引 ${startIdx}）位于结束序号 ${op.endSeq}（索引 ${endIdx}）之后`)
  }
  return {
    startIdx,
    endIdx,
    shadowedSeqs: state.nodes.slice(startIdx, endIdx + 1),
  }
}

/**
 * 对会话事件的 JSON 值域执行深层结构相等比较，包括 null、布尔值、数字、字符串、数组和普通对象。
 * 替代 node:util 的 isDeepStrictEqual，使本模块可在浏览器使用。
 */
function isDeepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => isDeepEqualJson(item, b[i]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a)
  const bRecord = b as Record<string, unknown>
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every(key => Object.hasOwn(b, key) && isDeepEqualJson((a as Record<string, unknown>)[key], bRecord[key]))
}

/** 将工具结果替换限制为当前某一个结果的内容。 */
function assertToolResultRewrite(
  event: SessionEvent,
  shadowedSeqs: readonly SessionSeq[],
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
): void {
  if (event.type !== 'tool/result') return
  if (shadowedSeqs.length !== 1) {
    throw new Error('tool/result 消息视图替换必须且只能重写一个当前节点')
  }
  for (const originalSeq of shadowedSeqs) {
    const original = events[originalSeq - baseSeq]
    if (original?.type !== 'tool/result') {
      throw new Error('tool/result 消息视图替换必须指向当前的 tool/result 节点')
    }
    const originalRest = { ...original.data } as Record<string, unknown>
    const replacementRest = { ...event.data } as Record<string, unknown>
    const originalResult = original.data.message.content[0]
    const replacementResult = event.data.message.content[0]
    originalRest['message'] = {
      ...original.data.message,
      content: [{ ...originalResult, content: null }],
    }
    replacementRest['message'] = {
      ...event.data.message,
      content: [{ ...replacementResult, content: null }],
    }
    if (!isDeepEqualJson(originalRest, replacementRest)) {
      throw new Error('tool/result 消息视图替换只能修改 content')
    }
  }
}

/**
 * 保护消息视图第 0 个节点的系统提示词。若替换范围覆盖该节点且它为 system/message，
 * 替换事件也必须是 system/message，且只能替换该节点。
 * 后续系统节点不受此保护，可以被压缩范围遮蔽。
 */
function assertSystemHeadRewrite(
  event: SessionEvent,
  state: SurfaceFoldState,
  startIdx: number,
  shadowedSeqs: readonly SessionSeq[],
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
): void {
  if (startIdx !== 0) return
  const head = events[state.nodes[0] as number - baseSeq]
  if (head?.type !== 'system/message') return
  if (event.type !== 'system/message' || shadowedSeqs.length !== 1) {
    throw new Error('消息视图替换：节点 0 保存系统提示词，只能由 system/message 单独重写该节点')
  }
}

/** 在重放边界校验单个事件，并准备原子的折叠状态转换。 */
export function planSurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
  expectedSeq: SessionSeq,
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
  projections: readonly SessionMessageProjection[],
): SurfacePlan | undefined {
  if (event.seq !== expectedSeq) {
    throw new Error(`会话事件序号 ${event.seq} 不连续；预期为 ${expectedSeq}`)
  }
  const surfaceOp = validateSurfaceMetadata(event)
  const projection = projections.find(item => item.type === event.type)
  if (projection !== undefined) {
    return { kind: 'project', projection, messages: projection.project(event, {
      nodes: state.nodes, events, baseSeq, messages: state.projectedMessages,
    }) }
  }
  if (MESSAGE_PROJECTION_EVENT_TYPES.has(event.type)) {
    throw new Error(`会话事件 "${event.type}" 需要消息投影；请加载所属插件或提供投影定义`)
  }
  if (surfaceOp === undefined) return
  if (surfaceOp === 'append') {
    return { kind: 'append', seq: event.seq }
  }
  const range = replacementRange(state, surfaceOp)
  assertSourceEventReferences(event, range.shadowedSeqs)
  assertToolResultRewrite(event, range.shadowedSeqs, events, baseSeq)
  assertSystemHeadRewrite(event, state, range.startIdx, range.shadowedSeqs, events, baseSeq)
  return {
    kind: 'replace',
    seq: event.seq,
    start: surfaceOp.startSeq,
    end: surfaceOp.endSeq,
    ...range,
  }
}

/** 应用单个事件，仅在发生替换时返回替换元数据。 */
export function applySurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
  expectedSeq: SessionSeq,
  events: readonly SessionEvent[],
  baseSeq: SessionLogOffset,
  projections: readonly SessionMessageProjection[],
): SurfaceFoldReplacement | undefined {
  const plan = planSurfaceEvent(state, event, expectedSeq, events, baseSeq, projections)
  return applySurfacePlan(state, plan)
}

/** 提交此前已校验的一次消息视图状态转换。 */
export function applySurfacePlan(
  state: SurfaceFoldState,
  plan: SurfacePlan | undefined,
): SurfaceFoldReplacement | undefined {
  if (plan?.kind === 'append') {
    state.nodes.push(plan.seq)
  } else if (plan?.kind === 'replace') {
    state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq)
    state.replaceGeneration += 1
    state.contentGeneration += 1
  } else if (plan?.kind === 'project') {
    for (const [seq, message] of plan.messages) state.projectedMessages.set(seq, message)
    state.projections.add(plan.projection)
    state.contentGeneration += 1
  }
  if (plan?.kind !== 'replace') return
  return {
    seq: plan.seq,
    start: plan.start,
    end: plan.end,
    shadowedSeqs: plan.shadowedSeqs,
  }
}

/**
 * 通过标准消息视图折叠流程重放完整会话日志。
 * @param events - 按连续序号排列的会话事件。
 * @param projections - 插件消息变更的纯函数解释器；必须提供所需定义。
 * @returns 与内部状态分离的当前序号和替换历史。
 * @throws 缺少解释器，或事件违反投影、视图元数据、来源归属或替换规则时抛错。
 */
export function foldSurface(events: readonly SessionEvent[], projections: readonly SessionMessageProjection[] = []): SurfaceFoldResult {
  const state = createFoldState()
  const replacements: SurfaceFoldReplacement[] = []
  for (const [index, event] of events.entries()) {
    const replacement = applySurfaceEvent(
      state,
      event,
      SessionSeq(index),
      events,
      SessionLogOffset(0),
      projections,
    )
    if (replacement !== undefined) replacements.push(replacement)
  }
  return { nodes: [...state.nodes], replacements, projectedMessages: new Map(state.projectedMessages) }
}
