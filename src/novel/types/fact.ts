import type { CharacterName, FactId } from './identifiers.ts'

/** 事实主体的类别。 */
export type SubjectKind = 'character' | 'location' | 'item' | 'relationship' | 'event' | 'world'

/** 事实时效状态：active=有效，retconned=被合理改写（旧值不删除），suspended=暂停。 */
export type FactStatus = 'active' | 'retconned' | 'suspended'

/**
 * 时态事实（真相库单元，文档 §3.4）。
 * 三元组：subject / predicate / object。`knownBy` 是信息差的根基：
 * "叶凡知道协议有对赌条款，苏晴不知道" 必须作为一等属性存在。
 */
export interface Fact {
  readonly factId: FactId
  readonly subject: string
  readonly subjectType: SubjectKind
  readonly predicate: string
  readonly object: string
  /** 自第几章起为真。 */
  readonly validFromChapter: number
  /** null = 至今为真。 */
  readonly validUntilChapter: number | null
  /** 由哪一章写入。 */
  readonly sourceChapter: number
  /** ★ 谁知道这条事实：角色名单；缺失表示无人知晓。 */
  readonly knownBy?: readonly CharacterName[]
  readonly status: FactStatus
}
