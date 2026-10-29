import { createToolResultMessage } from '@fly-novel/llm'
import type { ToolCallId } from '@fly-novel/llm'
import type { SessionEvent } from '@fly-novel/session'

/** 为未结束的持久化 Turn 生成工具结果和生命周期结束事件。 */
export function interruptedTurnClosers(events: readonly SessionEvent[], checkpointed: boolean): SessionEvent[] {
  let turn: number | undefined
  let step: number | undefined
  const pending = new Map<ToolCallId, { turn: number; step: number; started: boolean }>()
  for (const event of events) {
    switch (event.type) {
      case 'turn/start': turn = event.data.turn; step = undefined; pending.clear(); break
      case 'turn/end': turn = undefined; step = undefined; pending.clear(); break
      case 'step/start': step = event.data.step; break
      case 'step/end': step = undefined; pending.clear(); break
      case 'assistant/message':
        for (const block of event.data.message.content) if (block.type === 'tool-call') {
          pending.set(block.id, { turn: event.data.turn, step: event.data.step, started: false })
        }
        break
      case 'tool/call': {
        const call = pending.get(event.data.callId)
        if (call && call.turn === event.data.turn && call.step === event.data.step) call.started = true
        break
      }
      case 'tool/result': {
        const call = pending.get(event.data.message.source.callId)
        if (call && call.turn === event.data.turn && call.step === event.data.step) pending.delete(event.data.message.source.callId)
        break
      }
    }
  }
  const last = events.at(-1)
  if (turn === undefined || !last) return []
  const result: SessionEvent[] = []
  for (const [callId, call] of pending) {
    const unknown = call.started || !checkpointed
    const code = unknown ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_NOT_STARTED'
    const name = unknown ? 'ToolOutcomeUnknownError' : 'ToolNotStartedError'
    const text = unknown ? '工具执行结果未知；仅在只读或幂等时考虑重试，有副作用时先核实外部状态。' : '工具调用在执行前中断；如仍需要可以重试。'
    result.push({ type: 'tool/result', seq: last.seq + result.length + 1, time: last.time, data: {
      turn: call.turn, step: call.step,
      message: createToolResultMessage({ callId, isError: true, content: [{ type: 'text', text }] }),
      error: { name, code },
    } })
  }
  if (step !== undefined) result.push({ type: 'step/end', seq: last.seq + result.length + 1, time: last.time, data: { turn, step } })
  result.push({ type: 'turn/end', seq: last.seq + result.length + 1, time: last.time, data: { turn, reason: { kind: 'interrupted' } } })
  return result
}
