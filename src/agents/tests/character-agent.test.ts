import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { CharacterAgent } from "@fly-novel/agents";

test("角色 Agent 使用注入的模型响应角色调用", async () => {
  const agent = new CharacterAgent({
    model: new FakeListChatModel({ responses: ["我会回来。"] }),
    novelId: "test-novel",
    characterId: "character-lin-zhou",
    characterInfos: "林舟，沉着寡言，重视承诺。",
  });

  const result = await agent.invoke("苏晴问：明天还会回来吗？");
  const finalMessage = result.messages.at(-1);

  assert.ok(finalMessage);
  assert.equal(finalMessage.content, "我会回来。");
});
