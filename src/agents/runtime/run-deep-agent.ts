import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { createDeepAgent } from "deepagents";

/** 单次 Deep Agents 调用返回的原始运行状态。 */
export type DeepAgentRunResult = Awaited<ReturnType<ReturnType<typeof createDeepAgent>["invoke"]>>;

/** 使用已解析的模型执行一次受限 Deep Agents 调用。 */
export async function runDeepAgent(
  model: BaseLanguageModel,
  prompt: string,
  signal?: AbortSignal,
): Promise<DeepAgentRunResult> {
  const agent = createDeepAgent({
    model,
    permissions: [{
      operations: ["read", "write"],
      paths: ["/**"],
      mode: "deny",
    }],
  });
  return agent.invoke(
    { messages: [{ role: "user", content: prompt }] },
    { signal },
  );
}
