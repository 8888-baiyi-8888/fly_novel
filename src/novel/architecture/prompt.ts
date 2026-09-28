import { ChatMessage } from "../../harness/model/contract";
import { BookRules, StoryBible } from "../architect/types";
import { LongTermControls } from "../controls/types";
import { CreativeDraft } from "../draft/types";
import { buildCreativeBrief } from "../architect";
import { ArchitectureParts, Beat, ThreadEvent } from "./types";
import { ARCHITECTURE_JSON_DESCRIPTION, BEAT_BOARD_JSON_DESCRIPTION } from "./schema";
import { BeatChunk, collectChunkEvents, MAX_CHUNK_SIZE } from "./chunk";
import { OpenHook } from "./director-agent";

/** 架构师（前四件）系统提示词。 */
const ARCHITECT_SYSTEM_PROMPT = [
  "你是一名「架构师」，负责小说创作工作流建书第 5 步（N5）的前四件：故事框架、分卷规划、角色卡、叙事线地图。",
  "你会收到四份输入：故事圣经（这个世界是什么）、书籍规则（写作规则）、长期创作控制（作者想怎么写）、草案摘要（篇幅/卷规划）。",
  "你的任务：把输入组织成适合长篇规划的前四件数据结构。",
  "要求：",
  "- 严格按输出协议，只输出 JSON，不包含任何解释文字；",
  "- 世界事实必须以故事圣经为准，不得凭空新增与圣经冲突的设定；",
  "- 作者想法以长期创作控制为准，不得擅自改变作者意图与约束；",
  "- 角色分级 tier 按「决策需不需要被推理出来」判据；secret/knowledgeBoundary 必须具体填写。",
  ARCHITECTURE_JSON_DESCRIPTION,
].join("\n");

/** Director（节拍板）系统提示词。 */
const DIRECTOR_SYSTEM_PROMPT = [
  "你是一名「Director（导演）」，负责小说创作工作流建书第 5 步（N5）的节拍板：把分卷规划细化成全书章级蓝图。",
  "你会收到架构师的前四件（故事框架/分卷规划/角色卡/叙事线地图）+ 创作简报 + 目标总章数。",
  "你的任务：逐章规划全书蓝图，每章一句话概括本章发生的唯一大事。",
  "要求：",
  "- 严格按输出协议，只输出 JSON，不包含任何解释文字；",
  "- 严格满足输出协议中的全部节奏要求（相邻 3 章不全释放、伏笔密度 0.2–0.5、每条伏笔必须安排回收）；",
  "- 人物出场与动作要符合角色卡的人设与说话风格；",
  "- 节拍按叙事线地图推进：主线/分线/闪回线的事件按前置关系交错安排，汇合事件必须等两条线的前置都到位。",
  BEAT_BOARD_JSON_DESCRIPTION,
].join("\n");

/** 架构师输入：把四份输入汇总成一个 JSON 传给模型。 */
function buildArchitectUserContent(
  draft: CreativeDraft,
  bible: StoryBible,
  rules: BookRules,
  controls: LongTermControls,
): string {
  const digest = {
    draftSummary: {
      title: draft.title,
      blurb: draft.blurb,
      coreConflict: draft.coreConflict,
      targetChapters: draft.targetChapters,
      volumePlan: draft.volumePlan,
      constraints: draft.constraints,
    },
    storyBible: bible.sections,
    bookRules: rules.rules,
    longTermControls: {
      authorIntent: controls.authorIntent,
      currentFocus: controls.currentFocus,
      volumeDirections: controls.volumeDirections,
      constraints: controls.constraints,
    },
  };
  return `以下是四份输入（JSON）：\n${JSON.stringify(digest, null, 2)}`;
}

/** 组装「四份输入 → 架构师前四件」的模型消息。 */
export function buildArchitectureMessages(
  draft: CreativeDraft,
  bible: StoryBible,
  rules: BookRules,
  controls: LongTermControls,
): ChatMessage[] {
  return [
    { role: "system", content: ARCHITECT_SYSTEM_PROMPT },
    { role: "user", content: buildArchitectUserContent(draft, bible, rules, controls) },
  ];
}

/** 架构师重试反馈。 */
export function buildArchitectureRetryMessage(errorText: string): ChatMessage {
  return {
    role: "user",
    content: `你上一次的输出不符合协议：${errorText}。请重新输出符合协议的 JSON（storyFrame/volumeMap/characterCards/threadMap 四件齐全，tier 只能 S/A/B，secret 与 knowledgeBoundary 非空，汇合事件 requires 长度 ≥2 且 merge=true）。`,
  };
}

/** Director 输入：前四件 + 创作简报 + 目标总章数。 */
function buildDirectorUserContent(draft: CreativeDraft, parts: ArchitectureParts): string {
  return `以下是架构师前四件 + 创作简报 + 目标总章数（JSON）：\n${JSON.stringify(
    {
      targetChapters: draft.targetChapters,
      creativeBrief: buildCreativeBrief(draft),
      storyFrame: parts.storyFrame,
      volumeMap: parts.volumeMap,
      characterCards: parts.characterCards,
      threadMap: parts.threadMap,
    },
    null,
    2,
  )}`;
}

/** 组装「前四件 → 节拍板」的模型消息。 */
export function buildBeatBoardMessages(draft: CreativeDraft, parts: ArchitectureParts): ChatMessage[] {
  return [
    { role: "system", content: DIRECTOR_SYSTEM_PROMPT },
    { role: "user", content: buildDirectorUserContent(draft, parts) },
  ];
}

/** Director 重试反馈。 */
export function buildBeatBoardRetryMessage(errorText: string): ChatMessage {
  return {
    role: "user",
    content: `你上一次的节拍板不符合协议或验收闸门：${errorText}。请重新输出符合协议的节拍板：beats 长度必须等于目标总章数；mainBeat 非空且 ≤60 字；相邻 3 章 pacing 不全为「释放」；hookIntentions 密度在 0.2–0.5；每条 hookIntention 带【tag】前缀且必须在某章 plannedPayoffOf 中被回收。`,
  };
}

/** Director（分块模式）系统提示词：一次只规划一块，注意衔接。 */
const DIRECTOR_CHUNK_SYSTEM_PROMPT = [
  "你是一名「Director（导演）」，负责小说创作工作流建书第 5 步（N5）的节拍板。",
  "由于全书章节较多，节拍板按卷分块生成：你现在只负责其中一块（见输入中的 chunk 字段）。",
  "你会收到：全书上下文（前四件 + 创作简报 + 总章数）、本块信息（卷/标题/目标/阶段/章号区间）、",
  "本块必须覆盖的事件（mustCoverEvents，含前置关系）、上一块末尾节拍（prevTailBeats，本块开头必须承接其悬念与状态）、",
  "以及全书已埋设但尚未回收的伏笔清单（openHooks，本块可安排回收或继续推进）。",
  "你的任务：规划本块每一章的节拍，每章一句话概括本章发生的唯一大事。",
  "要求：",
  "- 严格按输出协议，只输出 JSON，不包含任何解释文字；",
  "- beats 长度必须等于本块章数（chunk 的章号区间宽度），chapter 字段从 1 递增到块长（块内序号，合并时系统会重编号为全局章号）；",
  "- hookIntention 的 tag 与 plannedPayoffOf 引用必须用块内章号命名：本块第 1 章埋的伏笔写【ch1-h1】、第 2 章写【ch2-h1】，依此类推（块内第 N 章 → chN-hX）；禁止使用全局章号命名 tag（全局号由合并时系统统一换算，你写块内号即可）；",
  "- 本块开头必须承接 prevTailBeats 末尾的悬念与人物状态，不能突兀重启剧情；",
  "- openHooks 里的伏笔在本块内可以回收（写进某章 plannedPayoffOf）或继续推进，但不得凭空消失；",
  "- 本块末尾可以留下跨块悬念（写进本块最后几章的 hookIntentions），下一块会承接；",
  "- mustCoverEvents 中的事件必须在本块对应章节出现（可多章展开，但事件本身必须发生）；",
  "- 严格满足输出协议中的节奏要求（相邻 3 章不全释放、伏笔密度 0.2–0.5、每条伏笔必须安排回收——全书闭环由合并后的验收闸门把关）；",
  "- 人物出场与动作要符合角色卡的人设与说话风格；",
  "- 节拍按叙事线地图推进：主线/分线/闪回线的事件按前置关系交错安排，汇合事件必须等两条线的前置都到位。",
  BEAT_BOARD_JSON_DESCRIPTION,
].join("\n");

/** 分块输入：全书上下文 + 本块信息 + 衔接材料。 */
function buildBeatBoardChunkUserContent(
  draft: CreativeDraft,
  parts: ArchitectureParts,
  chunk: BeatChunk,
  prevTail: Beat[],
  openHooks: OpenHook[],
): string {
  const events: ThreadEvent[] = collectChunkEvents(parts.threadMap, chunk);
  return `以下是分块节拍板输入（JSON）：\n${JSON.stringify(
    {
      targetChapters: draft.targetChapters,
      chunk: {
        id: chunk.id,
        volume: chunk.volume,
        title: chunk.title,
        goal: chunk.goal,
        stages: chunk.stages,
        chapterRange: [chunk.startChapter, chunk.endChapter],
      },
      mustCoverEvents: events,
      prevTailBeats: prevTail,
      openHooks,
      creativeBrief: buildCreativeBrief(draft),
      storyFrame: parts.storyFrame,
      volumeMap: parts.volumeMap,
      characterCards: parts.characterCards,
      threadMap: parts.threadMap,
    },
    null,
    2,
  )}`;
}

/** 组装「分块 → 单块节拍板」的模型消息。 */
export function buildBeatBoardChunkMessages(
  draft: CreativeDraft,
  parts: ArchitectureParts,
  chunk: BeatChunk,
  prevTail: Beat[],
  openHooks: OpenHook[],
): ChatMessage[] {
  return [
    { role: "system", content: DIRECTOR_CHUNK_SYSTEM_PROMPT },
    { role: "user", content: buildBeatBoardChunkUserContent(draft, parts, chunk, prevTail, openHooks) },
  ];
}

/** 分块重试反馈。 */
export function buildBeatBoardChunkRetryMessage(errorText: string, chunk: BeatChunk): ChatMessage {
  return {
    role: "user",
    content: `你上一次的输出不符合协议或验收闸门：${errorText}。请重新输出本块（${chunk.id}，ch${chunk.startChapter}-ch${chunk.endChapter}）符合协议的节拍板：beats 长度必须等于本块章数（${chunk.endChapter - chunk.startChapter + 1} 章）；chapter 从 1 递增；mainBeat 非空且 ≤60 字；相邻 3 章 pacing 不全为「释放」；每条 hookIntention 带【tag】前缀并最终有回收（全书闭环由合并校验把关，本块至少不要遗漏 prevTailBeats 与 openHooks 的承接）。`,
  };
}
