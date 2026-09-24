import { ChatMessage } from "../../harness/model/contract";
import { BookRules, StoryBible } from "../architect/types";
import { LongTermControls } from "../controls/types";
import { CreativeDraft } from "../draft/types";
import { buildCreativeBrief } from "../architect";
import { ArchitectureParts } from "./types";
import { ARCHITECTURE_JSON_DESCRIPTION, BEAT_BOARD_JSON_DESCRIPTION } from "./schema";

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
