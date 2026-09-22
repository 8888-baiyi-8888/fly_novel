/**
 * Agent 注册服务的占位类，尚未提供注册、查询或异步调用发起者追踪能力。
 * 当前不是 Cordis 服务，不应作为 ctx.agents 加载使用。
 */
export class AgentRegistry {
  withInitiator<T>(agent: Agent, operation: () => T): T {
    return this.runWithInitiator(agent, operation)
  }
  // TODO: 对照上游 AgentRegistry 实现 Agent 注册、工厂委派及发起者上下文，并明确资源清理方式。
}
