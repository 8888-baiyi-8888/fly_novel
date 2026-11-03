import { LlmError } from '@fly-novel/llm'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@fly-novel/subagent'
import { createInProcessAgent } from './create.js'
import type { InProcessAgentCreator } from './types.js'

/**
 * 创建子 Agent 并提交一次任务；返回运行句柄，不等待任务结束。
 * @param request 父 Agent、任务原文和取消信号。
 * @param create 创建子 Agent 和释放句柄的调用方。
 * @returns 已交付的运行句柄，调用方须处理结果并释放。
 * @throws 启动失败或创建交付前取消时拒绝。
 */
export async function startInProcessRun(request: SubagentStartRequest, create: InProcessAgentCreator): Promise<SubagentRun> {
  const handle = await createInProcessAgent(request, create)
  const { signal, prompt } = request
  let settled = false
  let cancelRequested = false

  const onAbort = () => {
    if (settled || cancelRequested) return
    cancelRequested = true
    handle.agent.cancel()
  }
  signal.addEventListener('abort', onAbort, { once: true })

  const result: Promise<SubagentResult> = (async () => {
    try {
      if (signal.aborted) return { output: '', stopReason: 'aborted' }
      const answer = await handle.agent.run({ prompt })
      return { output: answer.content, stopReason: 'completed' }
    } catch (error) {
      if (!(error instanceof LlmError)) throw error
      if (error.code === 'ABORTED') return { output: '', stopReason: 'aborted' }
      return { output: '', stopReason: 'error', errorCode: error.code }
    } finally {
      settled = true
      signal.removeEventListener('abort', onAbort)
    }
  })()
  // 调用方可能先释放句柄再等待结果；保留原 Promise 的拒绝供调用方处理。
  void result.catch(() => undefined)

  let disposePromise: Promise<void> | undefined
  return {
    id: handle.id,
    result,
    dispose() {
      if (disposePromise) return disposePromise
      disposePromise = (async () => {
        signal.removeEventListener('abort', onAbort)
        onAbort()
        const [disposal] = await Promise.allSettled([handle.dispose(), result])
        if (disposal.status === 'rejected') throw disposal.reason
      })()
      return disposePromise
    },
  }
}
