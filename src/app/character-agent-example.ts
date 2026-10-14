import { CharacterAgent } from "@fly-novel/agents";
import { createConfiguredChatOpenAI } from "./chat-openai-model";

async function main(): Promise<void> {
  const model = await createConfiguredChatOpenAI("deepseek", { disableThinking: true });
  const agent = new CharacterAgent({
    model,
    novelId: "debug-novel",
    branchId: "main",
    characterId: "debug-character",
  });
  const result = await agent.generate(
    "场景：雨后的渡口。苏晴问你：明天还会回来吗？请以林舟的身份自然回应，并通过动作体现他的情绪。",
  );
  console.dir(result, { depth: null });
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "角色 Agent 示例运行失败");
    process.exitCode = 1;
  });
}
