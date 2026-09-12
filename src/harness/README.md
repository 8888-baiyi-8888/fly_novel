# Agent 运行框架

## 一级子目录

| 子目录 | 作用 |
| --- | --- |
| [agent/](agent/README.md) | Agent 接口、注册、创建、查询和生命周期管理。 |
| [agent-loop/](agent-loop/README.md) | 驱动 Agent 调用大语言模型和工具，直至本轮结束。 |
| [llm/](llm/README.md) | 大语言模型的请求、响应和能力接口。 |
| [tools/](tools/README.md) | 工具定义、注册、输入校验和执行。 |
| [session/](session/README.md) | 会话状态和追加式事件日志。 |
| [session-persistence/](session-persistence/README.md) | 会话与事件日志的持久化接口。 |
| [session-persistence-jsonl/](session-persistence-jsonl/README.md) | 使用本地 JSONL 文件实现会话持久化。 |
| [system-prompt/](system-prompt/README.md) | 系统提示词片段的注册与组装。 |
| [subagent/](subagent/README.md) | 子 Agent 的创建、委派、状态查询和回收。 |
| [user-approval/](user-approval/README.md) | 人工确认请求及批准、拒绝结果的处理。 |
