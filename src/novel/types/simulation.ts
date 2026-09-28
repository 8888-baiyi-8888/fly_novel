import type { CharacterName } from './identifiers.ts'
import type { Tier } from './character.ts'

/**
 * 角色模拟输出（章节级文档 §6；字段按 §6.3 S 级回答四段与 §7.4 SceneSheet.material 推导）。
 * S 级持久会话与 A 级一次性调用均产出 Simulation；B 级无 Agent，不出此物。
 * merge 只取用 lines/actions/suspects 作为素材，不采信 reasoning/risk 作为剧情。
 */
export interface Simulation {
  readonly character: CharacterName
  readonly tier: Tier
  /** 台词素材。 */
  readonly lines: readonly string[]
  /** 动作素材。 */
  readonly actions: readonly string[]
  /** 角色此刻的怀疑，写入 CharacterState.suspects（信息差）。 */
  readonly suspects?: readonly string[]
  /** S 级【为什么】：内心逻辑，不直接进正文。 */
  readonly reasoning?: string
  /** S 级【风险】：这次选择可能造成的后果。 */
  readonly risk?: string
}
