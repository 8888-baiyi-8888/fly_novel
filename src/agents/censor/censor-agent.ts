import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { BaseAgent } from "../core/base-agent.js";
import { systemPrompt } from "./system-prompt.js";

export interface CensorAgentOptions {
  /** 应用创建的模型实例，包含模型选择与 API 凭据配置。 */
  readonly model: BaseLanguageModel;
}

/** 按调用方提供的内容规范审查正文，并报告违规依据和修改方向。 */
export class CensorAgent extends BaseAgent {
  public constructor(options: CensorAgentOptions) {
    super({ model: options.model, systemPrompt });
  }

  /** 根据调用方提供的正文和审查标准生成审查报告。 */
  public async generate(content: string) {
    return this.invoke(content);
  }
}
