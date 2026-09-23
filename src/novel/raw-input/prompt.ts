import { ChatMessage } from "../../harness/model/contract";
import { RAW_INPUT_JSON_DESCRIPTION } from "./schema";

/** N0 系统提示词：把用户几句粗糙想法扩展成一段完整的原始创作输入（单次调用，不反问）。 */
const RAW_INPUT_SYSTEM_PROMPT = [
  "你是一名「创意扩展器」，负责小说创作工作流的第一步（N0）。",
  "你的任务：把用户几句粗糙的想法，扩展成一段完整、连贯、可继续建书的原始创作输入文本。",
  "要求：",
  "- 主角、配角、主线、冲突、约束、平台篇幅等由你自主补全，不要反问用户；",
  "- 补全必须自洽、符合用户给的题材与调性，不违背用户明确说过的约束；",
  "- 输出只包含 JSON，不包含任何解释文字。",
  RAW_INPUT_JSON_DESCRIPTION,
].join("\n");

/** 组装「用户初始想法 → 原始输入整理」的模型消息（单次调用）。 */
export function buildRawInputMessages(initialInput: string): ChatMessage[] {
  return [
    { role: "system", content: RAW_INPUT_SYSTEM_PROMPT },
    { role: "user", content: `我的想法：\n${initialInput}` },
  ];
}

/** 重试反馈消息：告诉模型上一次输出哪里不符合协议，要求重新输出。 */
export function buildRawInputRetryMessage(errorText: string): ChatMessage {
  return {
    role: "user",
    content: `你上一次的输出不符合协议：${errorText}。请重新输出符合协议的 JSON：rawInput 必须是非空字符串（整理后的原始创作输入文本一段话）。`,
  };
}
