import { ChatMessage } from "../../harness/model/contract";
import { StoryArchitecture } from "../architecture/types";
import { STATE0_JSON_DESCRIPTION } from "./schema";

/** N6 系统提示词。 */
const STATE0_SYSTEM_PROMPT = [
  "你是一名「TruthOracle + Hook Ledger」，负责小说创作工作流建书第 6 步（N6）：初始化运行状态 State₀。",
  "你会收到 N5 五件套（故事框架/分卷规划/角色卡/叙事线地图/节拍板）。",
  "你的任务：回答一个问题——故事开始这一刻，世界到底处于什么状态？把静态架构转成六类动态初始值。",
  "要求：",
  "- 严格按输出协议，只输出 JSON，不包含任何解释文字；",
  "- 人物状态只写「这一刻」的状态（位置/身份/情绪/认知/资源），不要把角色卡的稳定属性搬进来；",
  "- 伏笔种子必须过准入闸门：type 非空、且 expectedPayoff 或 notes 至少一个非空（写不出怎么还的不登记）；",
  "- 种子档位按埋设→回收章距推定，总数不超过 12。",
  STATE0_JSON_DESCRIPTION,
].join("\n");

/** 组装「N5 五件套 → State₀」的模型消息。 */
export function buildState0Messages(architecture: StoryArchitecture): ChatMessage[] {
  const digest = {
    bookId: architecture.bookId,
    title: architecture.title,
    storyFrame: architecture.storyFrame,
    volumeMap: architecture.volumeMap,
    characterCards: architecture.characterCards,
    threadMap: architecture.threadMap,
    beatBoard: {
      totalChapters: architecture.beatBoard.beats.length,
      beats: architecture.beatBoard.beats,
    },
  };
  return [
    { role: "system", content: STATE0_SYSTEM_PROMPT },
    { role: "user", content: `N5 小说静态架构五件套（JSON）：\n${JSON.stringify(digest, null, 2)}` },
  ];
}

/** 重试反馈消息。 */
export function buildState0RetryMessage(errorText: string): ChatMessage {
  return {
    role: "user",
    content: `你上一次的输出不符合协议或校验：${errorText}。请重新输出符合协议的 State₀：六类齐全；伏笔种子 type 非空且 expectedPayoff 或 notes 至少一个非空；种子总数 ≤12；threadBoard.lineId 必须来自叙事线地图；progressState.currentChapter 为 0。`,
  };
}
