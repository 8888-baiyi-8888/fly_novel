# Agent Loop Turn 执行契约

## 问题

Agent Loop 开发需要先明确 `agent.run()` 的执行边界，避免把公开结果、Turn 状态和未来取消能力混成一套尚未需要的状态框架。

## 决定

- 每次 `AgentLoop.run({ prompt })` 调用对应一个 Turn。
- 成功时保持现有 `{ content: string }` 结果，由 `agent.run()` 原样返回助手文本。
- 执行失败时拒绝 Promise 并传播错误，不构造伪成功结果。
- 首阶段一个 Turn 只执行一个 Step；Turn/Step 的运行轨迹使用 Session 已定义的事件类型。
- 当前输入不增加取消信号，Agent 不增加取消方法；取消语义留到生命周期阶段处理。
- `AgentLoopRuntime` 和 `AgentLoop` 契约属于独立工作区包 `@fly-novel/agent-loop`；Cordis 插件使用当前 Agent Context 创建 Runtime，通过 `sessions` 服务获得 Session，并声明 `sessions`、`systemPrompt` 和 `llm` 依赖。`@fly-novel/agents` 依赖 Loop 包并注册插件，不转导 Loop Runtime。
- 公开 `run()` 保留用户输入参数；运行服务从同一 Context 取得，不为 Session、SystemPrompt 或 LLM 增加构造参数。
- `run()` 由类内私有 `turn()` 与 `step()` 方法执行，并沿用官方从 1 开始的 Turn/Step 序号。
- Step 失败时写入不包含异常详情的通用错误原因，再传播原始异常；避免把可能含敏感信息的异常文本写入 Session。

## 影响

现有 `AgentLoopInput` 与 `AgentLoopResult` 保持稳定，不增加 Turn ID、公开执行状态或取消参数。Loop 包依赖 Cordis 和 Session；SystemPrompt、LLM 服务由宿主 Preset 提供，Loop 包不依赖 Agents 包。当前固定 Step 不使用 SystemPrompt 或 LLM，也不发起模型请求。

## 验证

AgentLoop 测试覆盖 Cordis 依赖装配、Context 服务读取、Agent 销毁时的服务和 Session 清理、固定 Step 不调用测试 Adapter、同一 Agent 的 Session 复用、不同 Agent 的 Session 隔离，以及 `agent.run()` 的成功透传和错误传播。运行命令与结果记录在本次开发回复中。
