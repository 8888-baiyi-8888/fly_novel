import { ChatMessage } from "../../harness/model/contract";
import { DRAFT_JSON_DESCRIPTION } from "./schema";

const SYSTEM_PROMPT = [
  "你是一名小说创作助手，负责把用户散乱的创作想法整理成结构化创意草案。",
  "要求：",
  "- 忠实保留用户原意，不擅自新增设定，不编造用户没有表达的内容；",
  "- 尽量完整，不遗漏细节；拿不准、缺失或互相矛盾的地方写入 openQuestions；",
  "- 输出只包含 JSON，不包含任何解释文字。",
  DRAFT_JSON_DESCRIPTION,
].join("\n");

/** 组装「原始输入 → 草案整理」的模型消息。 */
export function buildDraftMessages(rawInput: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: rawInput },
  ];
}
