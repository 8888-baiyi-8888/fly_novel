import { createToolResultMessage } from '@fly-novel/llm'
import type { ToolCallBlock } from '@fly-novel/llm'
import type { Session } from '@fly-novel/session'

/** 为已记录的模型调用补齐缺失结果；已存在结果时不重复写入。 */
export function recoverToolCall(session: Session, turn: number, step: number, call: ToolCallBlock): void {
  const events = session.read()
  const completed = events.some(event => event.type === 'tool/result' && event.data.turn === turn &&
    event.data.step === step && event.data.message.source.callId === call.id)
  if (completed) return
  const started = events.some(event => event.type === 'tool/call' && event.data.turn === turn &&
    event.data.step === step && event.data.callId === call.id)
  const code = started ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_NOT_STARTED'
  const name = started ? 'ToolOutcomeUnknownError' : 'ToolNotStartedError'
  const text = started
    ? '工具调用已记录开始，但结果未记录，执行结果未知。仅在工具只读或幂等时考虑重试；可能有副作用时先核实外部状态。'
    : '工具调用在记录开始前中断；如仍有需要可以重试。'
  session.append('tool/result', {
    turn, step,
    message: createToolResultMessage({ callId: call.id, isError: true, content: [{ type: 'text', text }] }),
    error: { name, code },
  })
}
