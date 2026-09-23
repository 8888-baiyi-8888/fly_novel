import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import {
  CharacterAgent,
  configureAgentRuntime,
} from "@fly-novel/agents";

const requireFromAgentsPackage = createRequire(require.resolve("@fly-novel/agents"));
const deepagents: typeof import("deepagents") = requireFromAgentsPackage("deepagents");

test("角色 Agent 固定外部身份并在未配置运行时时拒绝", async () => {
  configureAgentRuntime(undefined);
  const agent = new CharacterAgent({
    modelId: "default",
    storyId: "novel-river",
    branchId: "main",
    characterId: "character-lin-zhou",
  });

  assert.deepEqual(agent.options, {
    modelId: "default",
    storyId: "novel-river",
    branchId: "main",
    characterId: "character-lin-zhou",
  });
  await assert.rejects(
    agent.run({ scene: { location: "渡口" }, outputRequirements: { scope: "保持沉默" } }),
    /尚未配置模型解析器/,
  );
});

test("角色 Agent 拒绝空的外部身份标识", () => {
  assert.throws(
    () => new CharacterAgent({ storyId: " ", characterId: "character-lin-zhou" }),
    /storyId 必须是非空字符串/,
  );
  assert.throws(
    () => new CharacterAgent({ modelId: "", storyId: "novel-river", characterId: "character-lin-zhou" }),
    /modelId 必须是非空字符串/,
  );
});

test("角色 Agent 通过内部 Deep Agents 调用转交模型、场景和取消信号", async (t) => {
  const controller = new AbortController();
  const result = { messages: [] };
  let creationInput: unknown;
  let invocationInput: unknown;
  let invocationOptions: unknown;
  t.mock.method(deepagents, "createDeepAgent", ((input) => {
    creationInput = input;
    return {
      async invoke(runInput: unknown, options: unknown) {
        invocationInput = runInput;
        invocationOptions = options;
        return result;
      },
    } as unknown as ReturnType<typeof deepagents.createDeepAgent>;
  }) as typeof deepagents.createDeepAgent);

  configureAgentRuntime({
    resolveModel(modelId) {
      assert.equal(modelId, "default");
      return {} as BaseLanguageModel;
    },
  });
  t.after(() => configureAgentRuntime(undefined));
  const agent = new CharacterAgent({
    modelId: "default",
    storyId: "novel-river",
    characterId: "character-lin-zhou",
  });

  assert.equal(await agent.run({
    scene: { location: "渡口" },
    outputRequirements: { scope: "回应苏晴" },
  }, { signal: controller.signal }), result);
  assert.deepEqual(creationInput, {
    model: {},
    permissions: [{ operations: ["read", "write"], paths: ["/**"], mode: "deny" }],
  });
  assert.deepEqual(invocationInput, {
    messages: [{
      role: "user",
      content: JSON.stringify({
        scene: { location: "渡口" },
        outputRequirements: { scope: "回应苏晴" },
      }),
    }],
  });
  assert.deepEqual(invocationOptions, { signal: controller.signal });
});
