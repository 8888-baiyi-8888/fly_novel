# 工具插件学习型开发计划

## 问题

Agent Loop 已有 LLM 工具调用协议类型，但当前 Loop 不执行工具。工具注册、参数定义、调用结果与 Loop 的职责需要按阶段学习和接入，避免只实现工具函数而遗漏模型可见 schema、Session 记录和下一步模型请求。

## 决定

- 按 DeepSeek Harness `dsh-tools` 与 `dsh-agent-loop` 的边界拆分学习：工具服务负责定义、注册、schema 和执行；Loop 负责 tool-call、Session 事件及后续 Step。
- 优先复用本项目 LLM 的 `ToolSchema`、tool-call/tool-result 内容块及 Session 的 `tool/call`、`tool/result` 事件。
- 第一条端到端能力采用原生 Function Calling 和只读小说资料工具；权限审批、PTC、MCP、UI、后台任务和复杂并发调度按实际需求另行规划。
- 每阶段先读官方文档或源码，说明输入、输出和预期行为，用固定 Adapter 验证，并对照官方实现后停止等待下一步。

## 影响

详细阶段、官方阅读入口与验收点由 [开发计划的工具插件开发章节](../../docs/development-plan.md)维护。
