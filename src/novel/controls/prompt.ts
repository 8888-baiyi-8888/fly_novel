import { ChatMessage } from "../../harness/model/contract";
import { CreativeDraft } from "../draft/types";
import { CONTROLS_JSON_DESCRIPTION } from "./schema";

/** 长期创作控制系统提示词：把草案创作意图整理扩展为四件套。 */
const CONTROLS_SYSTEM_PROMPT = [
  "你是一名「作者意图整理器」，负责小说创作工作流建书第 4 步（N4，与 N2/N3 并行）。",
  "你会收到创意草案中的创作意图部分（书名/简介/核心冲突/作者意图/风格/当前重点/卷规划/约束）。",
  "你的任务：把「作者想写什么」整理扩展为长期创作控制四件套（作者意图/当前重点/分卷方向/创作约束）。",
  "要求：",
  "- 严格按输出协议，只输出 JSON，不包含任何解释文字；",
  "- 只写作者主观想法与偏好，不写世界事实、不写具体章节写作规则；",
  "- 在草案基础上扩展细化，不擅自改变作者已明确表达的意图与约束。",
  CONTROLS_JSON_DESCRIPTION,
].join("\n");

/** 抽取草案中的创作意图部分（传给整理器的输入，减少噪声）。 */
function extractIntentPart(draft: CreativeDraft): object {
  return {
    title: draft.title,
    blurb: draft.blurb,
    coreConflict: draft.coreConflict,
    authorIntent: draft.authorIntent,
    tone: draft.tone,
    currentFocus: draft.currentFocus,
    volumePlan: draft.volumePlan,
    constraints: draft.constraints,
    openQuestions: draft.openQuestions,
  };
}

/** 组装「草案创作意图 → 长期创作控制」的模型消息。 */
export function buildControlsMessages(draft: CreativeDraft): ChatMessage[] {
  return [
    { role: "system", content: CONTROLS_SYSTEM_PROMPT },
    {
      role: "user",
      content: `创意草案的创作意图部分（JSON）：\n${JSON.stringify(extractIntentPart(draft), null, 2)}`,
    },
  ];
}

/** 重试反馈消息：告诉整理器上一次输出哪里不符合协议，要求重新输出。 */
export function buildControlsRetryMessage(errorText: string): ChatMessage {
  return {
    role: "user",
    content: `你上一次的输出不符合协议：${errorText}。请重新输出符合协议的 JSON：authorIntent 必须是非空字符串，currentFocus/constraints 必须是非空数组，volumeDirections 必须是非空数组（每项 volume/direction 非空）。`,
  };
}
