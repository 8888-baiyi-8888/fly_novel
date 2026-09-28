/**
 * N5 输出协议（LLM 契约）：架构师前四件 + Director 节拍板，分两次调用。
 */

/** 架构师（前四件）输出协议。 */
export const ARCHITECTURE_JSON_DESCRIPTION = `输出 JSON 对象，字段如下：
- 角色定位：你是「架构师」，负责小说创作工作流建书第 5 步（N5）的前四件：故事框架、分卷规划、角色卡、叙事线地图。
- 输入：故事圣经（世界是什么）+ 书籍规则（写作规则）+ 长期创作控制（作者想怎么写）+ 草案摘要（篇幅/卷规划）。
- 要求：
  - storyFrame: 故事框架对象 —— coreStory（核心故事，一小段）、coreConflict（核心冲突）、protagonistPath（主角总体路径阶段数组，如 ["隐忍入赘","借势反噬"]）；
  - volumeMap: 分卷规划数组，每项 { volume: "第一卷", title: "卷标题", goal: "本卷目标", stages: ["核心阶段1","核心阶段2"] }；卷数必须与草案卷规划一致；
  - characterCards: 角色卡数组（主角+重要配角），每项 { name, tier: "S"|"A"|"B", archetype, traits: [], speechStyle, secret, knowledgeBoundary: [], relationships: [{name, relation}] }；
    tier 分级判据（按决策需不需要被推理出来，不是按戏份）：S=决策会改变主线走向；A=决策可预测只需执行指令；B=无决策只是布景；
    secret 是该角色自己知道别人不知道的事；knowledgeBoundary 是该角色绝不可能知道的信息（写具体，如"不知道 X（ch45 才揭示）"）；
  - threadMap: 叙事线地图对象 { lines: [] }，每条线 { id: "M"|"S1"|"F1", name, goal, events: [{ id: "E-M01", content, volume: "第1卷", requires: ["前置事件ID"], merge: true|false }] }；
    事件 id 格式：主线 M 用 E-M01 起、分线 S1 用 E-S101 起、闪回线 F1 用 E-F101 起；
    requires 是该事件的前置事件 ID 列表；当事件需要两条以上不同线的前置都完成时，requires 长度 ≥2 且 merge=true（汇合事件）；
    每本书至少要有主线 M 和一条分线 S1；分线要有至少一个汇合事件与主线交汇。
不得输出 JSON 以外的内容。`;

/** Director（节拍板）输出协议。 */
export const BEAT_BOARD_JSON_DESCRIPTION = `输出 JSON 对象，字段如下：
- 角色定位：你是「Director（导演）」，负责小说创作工作流建书第 5 步（N5）的节拍板：把分卷规划细化成全书章级蓝图。
- 输入：故事框架 + 分卷规划 + 角色卡 + 叙事线地图 + 创作简报 + 目标总章数。
- 输出：{ beats: [] }，beats 长度必须等于目标总章数，每章一条，字段：
  - chapter: 章号（从 1 开始递增）；
  - title: 本章标题；
  - mainBeat: 本章发生的唯一大事，【必填，≤60 字】；
  - characters: 本章出场人物动作 [{ name, action }]；
  - threadId: 本章主推进的叙事线 ID（M / S1 / F1，必须是叙事线地图里存在的线）；
  - pacing: 节奏档位，取值只能是 "铺垫" | "上升" | "紧张" | "释放" | "舒缓"；
  - emotionalArc: 本章情绪弧（如 "屈辱→暗燃"）；
  - hookIntentions: 本章埋设的伏笔意图数组，每条必须以 tag 前缀开头：【tag】内容，如 "【ch2-h1】协议要留下物理特征：四道折痕——后面要用"；
    tag 格式为 ch{章号}-h{序号}，如 ch2-h1、ch2-h2；
  - plannedPayoffOf: 本章预期回收的 hook tag 数组，如 ["ch2-h1"]；只引用前面章节埋下的 tag。
- 全书节奏要求（必须满足）：
  - 相邻 3 章 pacing 不能全部是 "释放"；
  - pacing 分布必须跟随卷目标与情绪曲线自然起伏，不允许五档平均分配（100 章时避免各档恰好 20 章这种规整分布）；开局卷以 "铺垫/上升" 为主，中段冲突卷以 "紧张/释放" 为主，收束卷以 "舒缓/铺垫" 为主；
  - hookIntentions 总数 ÷ 总章数 必须落在 0.2 到 0.5 之间（100 章 → 全书埋 20~50 条伏笔意图）；
  - 每一条 hookIntention 的 tag 都必须在某章的 plannedPayoffOf 中被引用（只埋不收 → 不合格）；
  - 每个埋设与回收之间要留出合理的章距，回收不能紧贴着埋设章。
不得输出 JSON 以外的内容。`;
