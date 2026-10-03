import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { EvaluatorAgent } from "@fly-novel/agents";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";

const requireFromAgentsPackage = createRequire(require.resolve("@fly-novel/agents"));
const deepagents: typeof import("deepagents") = requireFromAgentsPackage("deepagents");
const { FakeListChatModel: BaseFakeListChatModel }: typeof import("@langchain/core/utils/testing") = requireFromAgentsPackage("@langchain/core/utils/testing");

test("评估 Agent 使用传入模型和评估提示词生成评估结果", async (t) => {
  class RecordingModel extends BaseFakeListChatModel {
    seen: BaseMessage[] = [];
    override async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
      this.seen = messages;
      return super._generate(messages, options);
    }
  }

  const model = new RecordingModel({ responses: ["问题：第二段缺少场景时间依据。"] });
  const create = t.mock.method(deepagents, "createDeepAgent");
  const agent = new EvaluatorAgent({ model: model as unknown as BaseLanguageModel });
  const result = await agent.invoke("评估标准：事实依据。正文：第二段写道‘天亮了’。");

  assert.equal(create.mock.callCount(), 1);
  const options = create.mock.calls[0]?.arguments[0];
  assert.ok(options);
  assert.equal(options.model, model);
  assert.match(typeof options.systemPrompt === "string" ? options.systemPrompt : "", /小说评估 Agent/);
  assert.ok(result.messages.some((message: BaseMessage) => JSON.stringify(message.content).includes("评估标准：事实依据")));
  assert.ok(result.messages.some((message: BaseMessage) => message.text.includes("第二段缺少场景时间依据")));
});
