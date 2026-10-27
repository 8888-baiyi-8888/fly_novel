# Agent Loop 单次 LLM 请求

## 问题

真实 Agent Loop 已建立 Turn/Step 执行闭环，但 Step 仍返回输入回显，无法验证现有 LLM 插件服务、模型路由及响应失败处理。

## 决定

- `agent-loop-runtime` 插件配置指定 `provider` 和 `model`；Adapter 路由继续由同一 Agent Preset 的 `llm` 插件配置。
- Step 将当前输入包装为一条不可变 user 消息，通过 Context 的 `llm.stream()` 发送一次无工具请求，并聚合文本增量。
- 请求执行和流结果处理留在 `step()`；请求对象由 `buildRequest()` 构造，对齐官方 Loop 中 `step()`、`prepareRequest()`、`buildRequest()` 的职责分配，不引入官方实现中不存在的 `requestModel()`。
- 仅 `stop` 被视为成功。LLM error/aborted finish 转为 `LlmError` 传播；工具调用、达到 token 上限和缺少结束块明确失败。
- 当前不读写 Session 消息历史，也不组装 SystemPrompt，分别留给开发计划第 6、7 步。

## 影响与验证

Loop 包新增 `@fly-novel/llm` workspace 依赖。固定 Adapter 测试路由字段、单条 user 消息、文本结果、LLM 失败传播和失败 Turn 事件；执行结果记在本次开发回复中。
