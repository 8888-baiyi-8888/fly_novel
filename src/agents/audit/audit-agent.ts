import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { BaseAgent } from "../core/base-agent.js";
import { systemPrompt } from "./system-prompt.js";

export interface AuditAgentOptions {
  /** 应用创建的模型实例，包含模型选择与 API 凭据配置。 */
  readonly model: BaseLanguageModel;
}

/** 按章节拍摄单、角色模拟和场景表核对正文的剧情与事实一致性。 */
export class AuditAgent extends BaseAgent {
  public constructor(options: AuditAgentOptions) {
    super({ model: options.model, systemPrompt });
  }

  /** 根据调用方提供的正文及核对材料生成审计报告。 */
  public async generate(content: string) {
    return this.invoke(content);
  }
}
