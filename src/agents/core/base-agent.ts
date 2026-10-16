import { createDeepAgent } from "deepagents";

type DeepAgentInstance = ReturnType<typeof createDeepAgent>;
type DeepAgentOptions = NonNullable<Parameters<typeof createDeepAgent>[0]>;
type DeepAgentInvokeConfig = Parameters<DeepAgentInstance["invoke"]>[1];

/** 提供 Deep Agent 的统一创建与文本调用入口；模板职责和提示词仍由子类定义。 */
export abstract class BaseAgent {
  private readonly agent: DeepAgentInstance;

  protected constructor(options: DeepAgentOptions) {
    this.agent = createDeepAgent(options);
  }

  /** 将单条文本作为用户消息提交给 Agent，可选传入该轮的 LangGraph 配置。 */
  protected invoke(content: string, config?: DeepAgentInvokeConfig) {
    return this.agent.invoke(
      { messages: [{ role: "user", content }] },
      config,
    );
  }
}
