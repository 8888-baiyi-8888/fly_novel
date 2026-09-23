import type { BaseLanguageModel } from "@langchain/core/language_models/base";

/** 应用启动时提供的 Agent 运行时能力。 */
export interface AgentRuntime {
  resolveModel(modelId: string | undefined): BaseLanguageModel | Promise<BaseLanguageModel>;
}

let runtime: AgentRuntime | undefined;

/** 注册所有 Agent 共用的模型解析能力；传入 `undefined` 可清理注册。 */
export function configureAgentRuntime(nextRuntime: AgentRuntime | undefined): void {
  runtime = nextRuntime;
}

/** 根据已注册运行时解析一个模型对象。 */
export async function resolveAgentModel(modelId: string | undefined): Promise<BaseLanguageModel> {
  if (runtime === undefined) {
    throw new Error("Agent 运行时尚未配置模型解析器。");
  }
  return runtime.resolveModel(modelId);
}
