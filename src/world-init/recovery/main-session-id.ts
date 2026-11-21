import { createHash } from 'node:crypto'

/** 主 Agent 的业务 Session ID 与持久化后端 ID 分属不同命名空间。 */
export function mainSessionPersistenceId(worldId: string, agentId: string, sessionId: string, mode: 'initialization' | 'discussion'): string {
  const prefix = mode === 'discussion' ? 'world-discussion' : 'world-initialization'
  return `${prefix}-${createHash('sha256').update(JSON.stringify([worldId, agentId, sessionId])).digest('hex')}`
}
