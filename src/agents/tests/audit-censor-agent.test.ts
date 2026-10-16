import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { AuditAgent, CensorAgent } from "@fly-novel/agents";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";

const requireFromAgentsPackage = createRequire(require.resolve("@fly-novel/agents"));
const deepagents: typeof import("deepagents") = requireFromAgentsPackage("deepagents");
const { FakeListChatModel: BaseFakeListChatModel }: typeof import("@langchain/core/utils/testing") = requireFromAgentsPackage("@langchain/core/utils/testing");

test("审计与内容审查 Agent 使用各自提示词生成报告", async (t) => {
  class RecordingModel extends BaseFakeListChatModel {
    seen: BaseMessage[] = [];
    override async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
      this.seen = messages;
      return super._generate(messages, options);
    }
  }

  const auditModel = new RecordingModel({ responses: ["PASS 审计通过"] });
  const censorModel = new RecordingModel({ responses: ["FAIL 发现违规"] });
  const create = t.mock.method(deepagents, "createDeepAgent");
  const audit = new AuditAgent({ model: auditModel as unknown as BaseLanguageModel });
  const censor = new CensorAgent({ model: censorModel as unknown as BaseLanguageModel });
  const auditResult = await audit.invoke("正文与 Dispatch、SceneSheet");
  const censorResult = await censor.invoke("正文与平台规范");

  assert.equal(create.mock.callCount(), 2);
  const auditOptions = create.mock.calls[0]?.arguments[0];
  const censorOptions = create.mock.calls[1]?.arguments[0];
  assert.ok(auditOptions);
  assert.ok(censorOptions);
  assert.match(typeof auditOptions.systemPrompt === "string" ? auditOptions.systemPrompt : "", /章节内容审计 Agent/);
  assert.match(typeof censorOptions.systemPrompt === "string" ? censorOptions.systemPrompt : "", /章节内容审查 Agent/);
  assert.ok(auditResult.messages.some((message: BaseMessage) => message.text.includes("PASS 审计通过")));
  assert.ok(censorResult.messages.some((message: BaseMessage) => message.text.includes("FAIL 发现违规")));
  assert.ok(auditModel.seen.some((message) => JSON.stringify(message.content).includes("正文与 Dispatch")));
  assert.ok(censorModel.seen.some((message) => JSON.stringify(message.content).includes("正文与平台规范")));
});
