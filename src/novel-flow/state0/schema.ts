/** N6 输出协议（LLM 契约）。 */

export const STATE0_JSON_DESCRIPTION = `输出 JSON 对象，字段如下：
- 角色定位：你是「TruthOracle + Hook Ledger」，负责小说创作工作流建书第 6 步（N6）：把静态架构转成初始运行状态 State₀。
- 输入：N5 五件套（故事框架/分卷规划/角色卡/叙事线地图/节拍板）。回答的是：故事开始这一刻，世界到底处于什么状态？
- 输出六类：
  - characterStates: 人物状态数组（每张角色卡至少一条），每项 { name, location: 当前位置, identity: 当前身份(公开), emotion: 当前情绪, cognition: 当前认知(知道/不知道什么), resources: 当前资金/资源 }；
  - relationshipStates: 关系状态数组（角色卡 relationships 里每条重要关系一条），每项 { subjects: ["甲","乙"], relation: 关系, trust: 信任程度, knowledge: 知情情况(谁不知道什么) }；
  - worldState: 世界状态键值对数组，每项 { key, value }，如 { key: "时间", value: "当代·春季" }、{ key: "公众是否知道龙王殿存在", value: "否" }；
  - hookSeeds: 伏笔种子数组（从节拍板 hookIntentions 提炼值得记账的），每项 { hookId: "H001" 起, beatTag: 对应节拍板 hookIntention 的 tag（如 "ch2-h1"）, plantedChapter: 埋设章, type: 物件|身份|信息差|秘密|威胁|承诺|关系|能力|事件, timing: immediate|near-term|mid-arc|slow-burn|endgame, core: 核心(可空), expectedPayoff: 回收章号(无法确定时 null), payoffNote: 预期回收描述, notes: 埋设原文 }；
  - threadBoard: 线状态板数组（叙事线地图每条线一条），每项 { lineId: 线ID, status: 进行中|冷藏|已完成, currentEvent: 当前事件ID(未开始 null), nextEvent: 下一事件ID, waitingFor: ["等待条件"], estimatedWake: "预计唤醒描述" }；
  - progressState: 当前进度对象 { currentChapter: 0, currentVolume: "第一卷…", stage: "故事开端", completedEvents: [], nextDirection: "下一主要方向" }。
- 伏笔种子准入三条硬规则（不满足的种子不要登记）：
  1. type 必须非空；
  2. expectedPayoff 或 notes 至少一个非空——写不出"打算怎么还"的，不是伏笔，只是在抒情，拒绝入账；
  3. beatTag 必须对应节拍板里真实存在的 hookIntention（tag 格式 ch{章号}-h{序号}），且该 tag 在节拍板某章的 plannedPayoffOf 中被引用（后面有回收，回收章 > 埋设章）——只埋不收的意图不登记，凭空编造的 tag 不登记。
- 档位按埋设→回收章距推定：≤3 章 immediate / 4–8 near-term / 10–20 mid-arc / 20–45 slow-burn / 更大或全书 endgame。
- 种子总数（activeCount）不得超过 12。
不得输出 JSON 以外的内容。`;
