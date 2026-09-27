import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { BaseAgent } from "../core/base-agent.js";
import { createDeepAgent } from "deepagents";
import { systemPrompt } from "./system-prompt.js";

export interface WriterAgentOptions {
  /** 应用创建的模型实例，包含模型选择与 API 凭据配置。 */
  readonly model: BaseLanguageModel;
}

/** 将已确认的事件与角色表现组织为正文草稿。 */
export class WriterAgent extends BaseAgent {
  private readonly agent;

  public constructor(options: WriterAgentOptions) {
    super();
    this.agent = createDeepAgent({ model: options.model, systemPrompt });
  }

  /** 根据调用方提供的写作材料生成正文草稿。 */
  public async invoke(content: string) {
    return this.agent.invoke({
      messages: [{ role: "user", content }],
    });
  }
}
