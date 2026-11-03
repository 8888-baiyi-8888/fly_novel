import { SubagentStartupCleanupError, type SubagentStartRequest } from '@fly-novel/subagent'
import type { InProcessAgentCreator, InProcessAgentHandle } from './types.js'

/**
 * 创建并交付 Agent 句柄；创建期间取消会等待创建结算并回滚迟到的句柄。
 * @param request 父 Agent、任务和取消信号。
 * @param create 负责创建和回滚未交付资源的创建方。
 * @returns 尚未执行任务的 Agent 句柄，调用方接收其释放责任。
 * @throws 创建失败或取消时拒绝；取消后的句柄清理失败时保留两个原因。
 */
export async function createInProcessAgent(
  request: SubagentStartRequest,
  create: InProcessAgentCreator,
): Promise<InProcessAgentHandle> {
  request.signal.throwIfAborted()
  const handle = await create(request)
  if (request.signal.aborted) {
    try {
      await handle.dispose()
    } catch (error) {
      throw new SubagentStartupCleanupError(request.signal.reason, error)
    }
    request.signal.throwIfAborted()
  }
  return handle
}
