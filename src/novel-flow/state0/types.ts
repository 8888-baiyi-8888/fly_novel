/**
 * novel/state0：初始化运行状态（State₀，N6）。
 * 把静态架构（N5）转成"故事开始这一刻，世界处于什么状态"的六类动态初始值。
 * State₀ 不是新的独立数据结构，而是 Fact/HookRecord/Thread/CharacterState/进度的初始值集合。
 */

/** 伏笔档位（对应平台爽点结构：immediate 章末钩子 / near-term 小爽点 / mid-arc 中爽点 / slow-burn 大爽点 / endgame 终局）。 */
export type HookTiming = "immediate" | "near-term" | "mid-arc" | "slow-burn" | "endgame";

/** 6.1 人物状态初始值。 */
export interface CharacterState {
  name: string;
  /** 当前位置。 */
  location: string;
  /** 当前身份（公开身份）。 */
  identity: string;
  /** 当前情绪。 */
  emotion: string;
  /** 当前认知（知道什么/不知道什么）。 */
  cognition: string;
  /** 当前资金/资源。 */
  resources: string;
}

/** 6.2 关系状态初始值。 */
export interface RelationshipState {
  /** 关系双方。 */
  subjects: string[];
  /** 关系，如 "挂名夫妻"。 */
  relation: string;
  /** 信任程度。 */
  trust: string;
  /** 知情情况（谁不知道什么）。 */
  knowledge: string;
}

/** 6.3 世界状态（键值对，如 时间=当代·春季 / 公众是否知道龙王殿存在=否）。 */
export interface WorldStateEntry {
  key: string;
  value: string;
}

/** 6.4 伏笔种子（HookRecord 初始登记，必须过准入闸门）。 */
export interface HookSeed {
  /** 账本编号，如 H001。 */
  hookId: string;
  /** 节拍板 hookIntention 的 tag（如 ch2-h1）——这条账来自 N5 节拍板的哪条意图，用于对账。 */
  beatTag: string;
  /** 埋设章节。 */
  plantedChapter: number;
  /** 伏笔类型：物件/身份/信息差/秘密/威胁/承诺/关系/能力/事件。 */
  type: string;
  /** 档位（按埋设→回收章距推定）。 */
  timing: HookTiming;
  /** 核心（可空）。 */
  core: string;
  /** 预期回收章节；无法确定时可为 null（此时 notes 必须非空）。 */
  expectedPayoff: number | null;
  /** 预期回收描述（怎么还）。 */
  payoffNote: string;
  /** 埋设原文（来自节拍板 hookIntention）。 */
  notes: string;
}

/** 6.5 线状态板（每条叙事线的动态初始状态）。 */
export interface ThreadBoardState {
  lineId: string;
  /** 进行中 / 冷藏 / 已完成。 */
  status: string;
  /** 当前事件 ID；尚未开始为 null。 */
  currentEvent: string | null;
  /** 下一事件 ID。 */
  nextEvent: string | null;
  /** 等待条件（前置事件描述）。 */
  waitingFor: string[];
  /** 预计唤醒描述。 */
  estimatedWake: string;
}

/** 6.6 当前进度。 */
export interface ProgressState {
  /** 当前章节，初始为 0。 */
  currentChapter: number;
  /** 当前卷。 */
  currentVolume: string;
  /** 当前剧情阶段（如 故事开端）。 */
  stage: string;
  /** 已完成事件（初始为空）。 */
  completedEvents: string[];
  /** 下一主要方向。 */
  nextDirection: string;
}

/** N6 产物：State₀ 六类。 */
export interface State0 {
  bookId: string;
  title: string;
  characterStates: CharacterState[];
  relationshipStates: RelationshipState[];
  worldState: WorldStateEntry[];
  hookSeeds: HookSeed[];
  threadBoard: ThreadBoardState[];
  progressState: ProgressState;
}
