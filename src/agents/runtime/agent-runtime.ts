import type { BaseLanguageModel } from "@langchain/core/language_models/base";

/** 应用启动时提供的 Agent 运行时能力。 */
export interface AgentRuntime {
  resolveModel(modelId: string | undefined): BaseLanguageModel | Promise<BaseLanguageModel>;
}

let runtime: AgentRuntime | undefined;

/** 注册模型解析器；传入 `undefined` 清理注册。 */
export function configureAgentRuntime(nextRuntime: AgentRuntime | undefined): void {
  if (nextRuntime === undefined) {
    runtime = undefined;
    return;
  }
  runtime = { ...nextRuntime };
}

/** 从当前运行时配置解析模型，避免异步解析期间重新注册造成混用。 */
export async function resolveAgentResources(modelId: string | undefined): Promise<{ model: BaseLanguageModel }> {
  if (runtime === undefined) {
    throw new Error("Agent 运行时尚未配置模型解析器。");
  }
  const current = runtime;
  return { model: await current.resolveModel(modelId) };
}
