import {SessionId} from "../session"

/** Public live-agent handle; the runtime face augments its live capabilities. */
export interface Agent {
  /** Session-backed Agent identity. */
  readonly id: SessionId
}

/** 
 * One of the two ordered pending-message lists owned by an agent.
 *   - `next-turn`：在下一轮（Turn）开始时处理。
 *   - `next-step`：在当前轮的下一步骤（Step）处理。
 */
export type InboxTarget = 'next-turn' | 'next-step'