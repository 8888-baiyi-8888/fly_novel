import type { CharacterName } from './identifiers.ts'

/**
 * 角色分级：S=决策会改变主线走向（持久会话），A=决策可预测（一次性调用），
 * B=无决策、只是布景（无 Agent）。分级依据是"决策需不需要被推理出来"，
 * 不是按戏份多少。
 */
export type Tier = 'S' | 'A' | 'B'

/** 角色关系条目。 */
export interface CharacterRelationship {
  readonly target: CharacterName
  readonly type: string
  readonly desc: string
}

/**
 * 角色卡（静态属性，文档 §3.7）。
 * `secret` + `knowledgeBoundary` + `suspects` 是角色系统与伏笔系统的接口：
 * S 级 Agent 的 System Prompt 直接注入前两者；`suspects` 变化是伏笔 advance 的合法形态。
 */
export interface CharacterCard {
  readonly name: CharacterName
  readonly tier: Tier
  readonly archetype: string
  readonly aliases: readonly string[]
  /** 性格，审计时用于"这人不会这么做"。 */
  readonly traits: readonly string[]
  /** 台词指纹。 */
  readonly speechStyle: string
  readonly goals: readonly string[]
  readonly fears: readonly string[]
  /** ★ 角色自己知道、别人不知道的事。 */
  readonly secret: string
  /** ★ 该角色"绝不可能知道"的信息。 */
  readonly knowledgeBoundary: readonly string[]
  readonly relationships: readonly CharacterRelationship[]
}

/**
 * 角色运行时状态（动态属性，每章 settle 后更新，文档 §3.7）。
 */
export interface CharacterState {
  readonly name: CharacterName
  readonly location: string
  readonly goal: string
  readonly emotion: string
  /** 从 TruthOracle 派生：knownBy ∋ 本角色。 */
  readonly knows: readonly string[]
  /** ★ 半知状态：伏笔即将引爆的临界信号。 */
  readonly suspects: readonly string[]
  readonly inventory: readonly string[]
  /** 关系值 -100..100。 */
  readonly bonds: Readonly<Record<string, number>>
}
