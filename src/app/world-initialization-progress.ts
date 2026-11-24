import type { Agent } from '@fly-novel/agents'
import type { ToolCallId } from '@fly-novel/llm'

const toolLabels: Readonly<Record<string, string>> = {
  delegate_world_basics: '世界基础 Agent',
  delegate_character_creator: '人物 Agent',
  delegate_map: '地图 Agent',
  delegate_organization: '组织 Agent',
  delegate_history: '历史 Agent',
  delegate_initial_situation: '初始局势 Agent',
  delegate_world_development: '世界发展规划 Agent',
  delegate_world_specific: '世界专有内容 Agent',
}

/** 仅显示主 Agent 的运行事件；子 Agent 内部事件不通过此监听器传递。 */
export function observeWorldInitializationProgress(agent: Pick<Agent, 'context'>, write: (text: string) => void, heartbeatMs = 15_000): () => void {
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new Error('进度提示间隔必须是正整数')
  const session = agent.context.sessions.list()[0]
  if (!session) throw new Error('无法显示进度：主 Agent 没有 Session')
  const started = Date.now()
  const active = new Map<ToolCallId, { label: string; since: number }>()
  let lastActivity = started
  let detached = false
  const report = (text: string) => {
    try { write(`进度> ${text}`) }
    catch (error) { process.emitWarning('进度输出失败，业务运行继续', { detail: error instanceof Error ? error.message : String(error) }) }
  }
  const off = agent.context.on('session/event', (source, event) => {
    if (detached || source !== session) return
    lastActivity = Date.now()
    if (event.type === 'step/start') report(`主 Agent 第 ${event.data.step} 步开始。`)
    if (event.type === 'tool/call') {
      const label = toolLabels[event.data.name] ?? `工具 ${event.data.name}`
      active.set(event.data.callId, { label, since: Date.now() })
      report(`开始调用${label}。`)
    }
    if (event.type === 'tool/result') {
      const callId = event.data.message.source.callId
      const entry = active.get(callId)
      if (!entry) return
      active.delete(callId)
      const block = event.data.message.content.find(item => item.type === 'tool-result')
      const failed = Boolean(event.data.error || (block?.type === 'tool-result' && block.isError))
      report(`${entry.label}已返回：${failed ? '失败，请查看后续结果' : '调用未报错'}（耗时 ${Math.floor((Date.now() - entry.since) / 1000)} 秒）。`)
    }
  })
  const timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000)
    const waiting = [...active.values()].map(item => `${item.label}（${Math.floor((Date.now() - item.since) / 1000)} 秒）`)
    if (waiting.length) report(`已运行 ${seconds} 秒，等待 ${waiting.join('、')} 返回；子 Agent 内部步骤不会实时显示。`)
    else report(`已运行 ${seconds} 秒，距主 Agent 上次事件 ${Math.floor((Date.now() - lastActivity) / 1000)} 秒；等待主 Agent 下一步，可能正在请求模型。`)
  }, heartbeatMs)
  return () => {
    if (detached) return
    detached = true
    clearInterval(timer)
    off()
  }
}
