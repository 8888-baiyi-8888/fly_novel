import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { createMiddleware } from "langchain";
import type { SupportedResponseFormat } from "deepagents";

export type DeepAgentInstance = ReturnType<typeof createDeepAgent>;

/** 单次 Deep Agents 调用返回的原始运行状态。 */
export type DeepAgentRunResult = Awaited<ReturnType<ReturnType<typeof createDeepAgent>["invoke"]>>;

/** 创建独立会话；检查点仅保存在内存中，模型只使用结构化输出工具。 */
export function createModelAgent(model: BaseLanguageModel, systemPrompt: string, getResponseFormat: () => SupportedResponseFormat): DeepAgentInstance {
  return createDeepAgent({
    model,
    checkpointer: new MemorySaver(),
    systemPrompt,
    responseFormat: getResponseFormat(),
    middleware: [createMiddleware({
      name: "RunResponseFormat",
      // 仅提供框架生成的结构化输出工具；思考模型可能拒绝 required。
      wrapModelCall: (request, handler) => handler({ ...request, tools: [], responseFormat: getResponseFormat(), toolChoice: "auto" }),
    })],
  });
}

import type { BaseMessage } from "@langchain/core/messages";

/** 调用 Deep Agent；仅提交新增消息，后续历史由实例检查点读取。 */
export async function runDeepAgent(
  agent: DeepAgentInstance,
  messages: BaseMessage[],
  signal?: AbortSignal,
): Promise<DeepAgentRunResult> {
  return agent.invoke(
    {
      messages,
      structuredResponse: undefined,
    },
    { signal, configurable: { thread_id: "character-session" } },
  );
}
