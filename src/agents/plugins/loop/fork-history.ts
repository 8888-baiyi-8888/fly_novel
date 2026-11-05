import { Session, type SessionEvent } from '@fly-novel/session'

function isTextContent(content: unknown): boolean {
  return Array.isArray(content) && content.every((block: unknown) => block !== null && typeof block === 'object' &&
    'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string')
}

/** 验证完整、纯文本的轮次前缀，返回与输入独立的不可变事件。 */
export function validateForkHistory(events: readonly SessionEvent[]): readonly SessionEvent[] {
  if (!Array.isArray(events)) throw new Error('Fork 历史必须是事件数组')
  let turn: number | undefined
  let step: number | undefined
  let previousTurn = 0
  for (const [index, event] of events.entries()) {
    if (!event || event.seq !== index || !Number.isFinite(event.time) || !event.data) throw new Error('Fork 历史事件或序号无效')
    switch (event.type) {
      case 'turn/start':
        if (turn !== undefined || !Number.isSafeInteger(event.data.turn) || event.data.turn <= previousTurn) throw new Error('Fork 历史轮次无效')
        turn = event.data.turn
        previousTurn = event.data.turn
        break
      case 'turn/end':
        if (turn === undefined || event.data.turn !== turn || step !== undefined) throw new Error('Fork 历史轮次未闭合')
        turn = undefined
        break
      case 'step/start':
        if (turn === undefined || event.data.turn !== turn || step !== undefined || !Number.isSafeInteger(event.data.step) || event.data.step < 1) throw new Error('Fork 历史步骤无效')
        step = event.data.step
        break
      case 'step/end':
        if (turn === undefined || event.data.turn !== turn || event.data.step !== step) throw new Error('Fork 历史步骤未闭合')
        step = undefined
        break
      case 'system/message':
      case 'assistant/message': {
        if (turn === undefined || step === undefined || event.data.turn !== turn || event.data.step !== step) throw new Error('Fork 历史消息不属于活动步骤')
        const message = event.data.message
        if (!message || !isTextContent(message.content) || message.role !== (event.type === 'system/message' ? 'system' : 'assistant')) throw new Error('Fork 历史包含不支持的非文本消息')
        if (event.type === 'assistant/message' && (event.data.message.source?.kind !== 'model' || event.data.message.source.replayState !== undefined)) throw new Error('Fork 历史包含不支持的重放状态或消息来源')
        break
      }
      case 'user/message':
        if (turn === undefined || step === undefined || event.data.role !== 'user' || event.data.source?.kind !== 'user' || !isTextContent(event.data.content)) throw new Error('Fork 历史包含不支持的用户消息')
        break
      default:
        throw new Error('Fork 历史包含不支持的事件')
    }
  }
  if (turn !== undefined || step !== undefined) throw new Error('Fork 历史轮次未闭合')
  const session = new Session({ seed: events })
  try { return session.read() } finally { session.close() }
}
