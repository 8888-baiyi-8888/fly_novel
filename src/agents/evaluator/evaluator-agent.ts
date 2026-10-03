import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { BaseAgent } from "../core/base-agent.js";
import { createDeepAgent } from "deepagents";
import { systemPrompt } from "./system-prompt.js";

export interface EvaluatorAgentOptions {
  /** 应用创建的模型实例，包含模型选择与 API 凭据配置。 */
  readonly model: BaseLanguageModel;
}

/** 按调用方提供的标准评估指定版本内容。 */
export class EvaluatorAgent extends BaseAgent {
  private readonly agent;

  public constructor(options: EvaluatorAgentOptions) {
    super();
    this.agent = createDeepAgent({ model: options.model, systemPrompt });
  }

  /** 根据调用方提供的评估对象与标准生成评估结果。 */
  public async invoke(content: string) {
    return this.agent.invoke({
      messages: [{ role: "user", content }],
    });
  }
}
