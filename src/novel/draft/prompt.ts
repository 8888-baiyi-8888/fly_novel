import { ChatMessage } from "../../harness/model/contract";
import { CLARIFY_JSON_DESCRIPTION, DRAFT_JSON_DESCRIPTION } from "./schema";

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


/** 澄清轮系统提示词：协议版（原 SYSTEM_PROMPT 保持不变，供 createDraft 使用）。 */
const CLARIFY_SYSTEM_PROMPT = [
  "你是一名小说创作助手，负责把用户散乱的创作想法整理成结构化创意草案。",
  "整理过程中，信息不足或相互矛盾时，先向用户提问澄清，而不是自行编造设定。",
  "要求：",
  "- 忠实保留用户原意，不擅自新增设定，不编造用户没有表达的内容；",
  "- 输出只包含 JSON，不包含任何解释文字。",
  CLARIFY_JSON_DESCRIPTION,
].join("\n");

/** 澄清流程第一轮消息：system（澄清协议）+ user（原始输入）。 */
export function buildClarifyMessages(rawInput: string): ChatMessage[] {
  return [
    { role: "system", content: CLARIFY_SYSTEM_PROMPT },
    { role: "user", content: rawInput },
  ];
}

/** 把模型本轮提出的问题转为 assistant 消息，追加进对话历史。 */
export function buildClarifyQuestionsMessage(questions: string[]): ChatMessage {
  const list = questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
  return { role: "assistant", content: `需要澄清的问题：\n${list}` };
}

/** 把用户对上一轮问题的回答转为 user 消息，追加进对话历史。 */
export function buildClarifyAnswerMessage(answer: string): ChatMessage {
  return { role: "user", content: `用户回答：${answer}` };
}

/** 最终轮指令：要求模型基于全部信息给出完整草案，未决问题写入 openQuestions。 */
export function buildClarifyFinalMessage(): ChatMessage {
  return {
    role: "user",
    content:
      "用户已回答完所有问题（或表示不再回答）。现在请基于以上全部信息输出最终创意草案：" +
      "questions 必须为空数组，完整草案填入 draft 字段；如仍有无法澄清的问题，写入草案的 openQuestions 字段。",
  };
}
