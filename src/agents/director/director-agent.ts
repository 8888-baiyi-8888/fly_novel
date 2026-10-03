import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { BaseAgent } from "../core/base-agent.js";
import { createDeepAgent } from "deepagents";
import { systemPrompt } from "./system-prompt.js";

export interface DirectorAgentOptions {
  /** 应用创建的模型实例；其中包含模型选择与 API 凭据配置。 */
  model: BaseLanguageModel;
}

/** 导演 Agent */
export class DirectorAgent extends BaseAgent {
  private readonly agent;

  public constructor(options: DirectorAgentOptions) {
    super();

    this.agent = createDeepAgent({
      model: options.model,
      systemPrompt,
    });
  }

  public async invoke(content: string) {
    return this.agent.invoke({
      messages: [
        {
          role: "user",
          content,
        },
      ],
    });
  }
}
