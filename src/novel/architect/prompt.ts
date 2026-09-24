import { ChatMessage } from "../../harness/model/contract";
import { BookConfig } from "../book-config/types";
import { CreativeDraft } from "../draft/types";
import { ARCHITECT_JSON_DESCRIPTION } from "./schema";

/** 架构师系统提示词：根据创作简报 + 创意草案 + BookConfig 构建故事圣经与书籍规则。 */
const ARCHITECT_SYSTEM_PROMPT = [
  "你是一名「架构师」，负责小说创作工作流建书第 3 步（N3）。",
  "你会收到：创作简报（浓缩需求）、创意草案（结构化草稿）、书籍配置（运行参数）。",
  "你的任务：产出故事圣经（这个世界是什么）+ 书籍规则（这本书允许怎么写）。",
  "要求：",
  "- 严格按输出协议，只输出 JSON，不包含任何解释文字；",
  "- 与输入保持自洽，不编造与输入冲突的设定；",
  "- 不要生成通用的 AI 写作红线（内置，不需要你写）。",
  ARCHITECT_JSON_DESCRIPTION,
].join("\n");

/** 组装「简报 + 草案 + BookConfig → 架构师」的模型消息。 */
export function buildArchitectMessages(
  brief: string,
  draft: CreativeDraft,
  bookConfig: BookConfig,
): ChatMessage[] {
  return [
    { role: "system", content: ARCHITECT_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `创作简报：\n${brief}`,
        `创意草案（JSON）：\n${JSON.stringify(draft, null, 2)}`,
        `书籍配置（JSON）：\n${JSON.stringify(bookConfig, null, 2)}`,
      ].join("\n\n"),
    },
  ];
}

/** 重试反馈消息：告诉架构师上一次输出哪里不符合协议，要求重新输出。 */
export function buildArchitectRetryMessage(errorText: string): ChatMessage {
  return {
    role: "user",
    content: `你上一次的输出不符合协议：${errorText}。请重新输出符合协议的 JSON：storyBible 必须是非空数组（每项 title/content 非空），bookRules 必须是非空数组（每项 content 非空）。`,
  };
}
