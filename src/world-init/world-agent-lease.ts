/** 进程内业务身份占用；进程外写入仍由可信应用保证独占。 */
const occupied = new Set<string>()

/**
 * 从启动前占用一个世界内 Agent 身份，释放失败时调用方不得解除占用。
 * @param worldId 稳定世界身份。
 * @param agentId 稳定 Agent 身份。
 * @returns 成功清理所有资源后调用的幂等释放函数。
 * @throws 同一身份已被当前进程占用时抛错。
 */
export function acquireWorldAgentLease(worldId: string, agentId: string): () => void {
  const key = JSON.stringify([worldId, agentId])
  if (occupied.has(key)) throw new Error('世界 Agent 身份正在使用')
  occupied.add(key)
  let released = false
  return () => {
    if (released) return
    released = true
    occupied.delete(key)
  }
}
