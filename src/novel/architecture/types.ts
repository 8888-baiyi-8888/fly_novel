/**
 * novel/architecture：小说静态架构（Story Architecture，N5）。
 * 把故事圣经 + 书籍规则 + 长期创作控制组织成更适合长篇规划的数据结构。
 * 五件套：故事框架 / 分卷规划 / 角色卡 / 叙事线地图（架构师产出）+ 节拍板（Director 产出）。
 */

/** 角色分级：按「决策需不需要被推理出来」，不是按戏份。 */
export type Tier = "S" | "A" | "B";

/** 5.1 故事框架：这本书整体讲哪条主线。 */
export interface StoryFrame {
  /** 核心故事（一句话/一小段）。 */
  coreStory: string;
  /** 核心冲突。 */
  coreConflict: string;
  /** 主角总体路径（阶段链），如 ["隐忍入赘", "借势反噬", "势力重聚"]。 */
  protagonistPath: string[];
}

/** 5.2 分卷规划：把整本故事拆成几个大剧情阶段（卷级粒度）。 */
export interface VolumeMapItem {
  /** 卷名，如 "第一卷"。 */
  volume: string;
  /** 卷标题，如 "离婚协议"。 */
  title: string;
  /** 本卷目标。 */
  goal: string;
  /** 核心阶段（关键事件序列）。 */
  stages: string[];
}

/** 角色卡中的关系条目。 */
export interface CharacterRelationship {
  name: string;
  relation: string;
}

/** 5.3 角色卡：各角色稳定属性 + S/A/B 分级。 */
export interface CharacterCard {
  name: string;
  tier: Tier;
  /** 定位，如 protagonist / deuteragonist / rival。 */
  archetype: string;
  traits: string[];
  /** 说话风格（供章节写手与角色模拟使用）。 */
  speechStyle: string;
  /** 角色自己知道、别人不知道的事（伏笔系统接口）。 */
  secret: string;
  /** 该角色绝不可能知道的信息（伏笔系统接口）。 */
  knowledgeBoundary: string[];
  relationships: CharacterRelationship[];
}

/** 叙事线事件：逻辑层（事件链 + 前置 + 汇合）。 */
export interface ThreadEvent {
  /** 事件编号，如 E-M01 / E-S103 / E-F101。 */
  id: string;
  content: string;
  /** 卷区间，如 "第1卷"。 */
  volume: string;
  /** 前置事件 ID 列表；长度 ≥2 时为汇合事件（多线交汇）。 */
  requires: string[];
  /** 是否汇合事件（requires 来自两条以上不同线）。 */
  merge: boolean;
}

/** 叙事线（主线 M / 分线 S / 闪回线 F）。 */
export interface ThreadLine {
  id: string;
  name: string;
  goal: string;
  events: ThreadEvent[];
}

/** 5.4 叙事线地图：多线路并行的「线」骨架。 */
export interface ThreadMap {
  lines: ThreadLine[];
}

/** 节拍板 pacing 档位。 */
export type Pacing = "铺垫" | "上升" | "紧张" | "释放" | "舒缓";

/** 节拍中的人物动作条目。 */
export interface BeatCharacter {
  name: string;
  action: string;
}

/** 5.5 节拍（全书章级蓝图中的一章）。 */
export interface Beat {
  chapter: number;
  title: string;
  /** 本章发生的唯一大事，≤60 字（验收闸门硬性）。 */
  mainBeat: string;
  characters: BeatCharacter[];
  /** 属于哪条叙事线。 */
  threadId: string;
  pacing: Pacing;
  emotionalArc: string;
  /**
   * 规划期伏笔意图，每条带 tag 前缀：【tag】内容，如 "【ch2-h1】协议要留下四道折痕——后面要用"。
   * 每个 tag 必须被某章的 plannedPayoffOf 引用（验收闸门：只埋不收 → blocking）。
   */
  hookIntentions: string[];
  /** 预期回收哪些 hook tag（如 ["ch2-h1"]）；规划期引用，N6 才转正式 HookRecord。 */
  plannedPayoffOf: string[];
}

/** 5.5 节拍板：全书章级蓝图，长度 = targetChapters。 */
export interface BeatBoard {
  beats: Beat[];
}

/** 架构师前四件（故事框架/分卷规划/角色卡/叙事线地图）。 */
export interface ArchitectureParts {
  storyFrame: StoryFrame;
  volumeMap: VolumeMapItem[];
  characterCards: CharacterCard[];
  threadMap: ThreadMap;
}

/** N5 五件套产物（落盘结构）。 */
export interface StoryArchitecture extends ArchitectureParts {
  bookId: string;
  title: string;
  beatBoard: BeatBoard;
}
