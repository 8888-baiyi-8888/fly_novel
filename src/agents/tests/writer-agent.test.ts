import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { WriterAgent } from "@fly-novel/agents";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { WRITE_BANS, WRITE_STYLE_GUIDE } from "../writer/system-prompt.js";

const requireFromAgentsPackage = createRequire(require.resolve("@fly-novel/agents"));
const deepagents: typeof import("deepagents") = requireFromAgentsPackage("deepagents");
const { FakeListChatModel: BaseFakeListChatModel }: typeof import("@langchain/core/utils/testing") = requireFromAgentsPackage("@langchain/core/utils/testing");

test("写作 Agent 使用传入模型和写作提示词生成草稿", async (t) => {
  class RecordingModel extends BaseFakeListChatModel {
    seen: BaseMessage[] = [];
    override async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
      this.seen = messages;
      return super._generate(messages, options);
    }
  }

  const model = new RecordingModel({ responses: ["雨停后，林舟站在渡口等候。"] });
  const create = t.mock.method(deepagents, "createDeepAgent");
  const agent = new WriterAgent({ model: model as unknown as BaseLanguageModel });
  const result = await agent.generate("已确认：雨停后两人在渡口相遇。写一段克制的场景正文。");

  assert.equal(create.mock.callCount(), 1);
  const options = create.mock.calls[0]?.arguments[0];
  assert.ok(options);
  assert.equal(options.model, model);
  const prompt = typeof options.systemPrompt === "string" ? options.systemPrompt : "";
  assert.match(prompt, /小说章节正文写手/);
  assert.match(prompt, /禁止章节标题、编号、列表、JSON、Markdown 代码块/);
  assert.equal(WRITE_BANS.length, 10);
  for (const ban of WRITE_BANS) assert.ok(prompt.includes(ban), `系统提示词应包含禁令：${ban.slice(0, 12)}…`);
  for (const guideline of WRITE_STYLE_GUIDE) assert.ok(prompt.includes(guideline), `系统提示词应包含文风要求：${guideline.slice(0, 12)}…`);
  assert.ok(result.messages.some((message: BaseMessage) => JSON.stringify(message.content).includes("已确认：雨停后两人在渡口相遇")));
  assert.ok(result.messages.some((message: BaseMessage) => message.text.includes("雨停后，林舟站在渡口等候。")));
});
