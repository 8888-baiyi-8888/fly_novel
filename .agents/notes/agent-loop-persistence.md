# Agent Loop 持久化会话接入

问题：Loop 总是创建内存 Session，调用方无法恢复已有持久化历史。

决定：在 Loop 配置中用 sessionId 明确新建，用 resumeSessionId 明确恢复；应用负责装配持久化服务。将已有持久化服务契约设为独立工作区包，使 Loop 和 JSONL 后端共享契约，避免 Loop 依赖 Agents 包。

影响：不配置会话 ID 时保持内存模式；持久化初始化失败时清理句柄。中断 Turn 和工具调用的崩溃恢复仍由后续步骤处理。

验证：测试编译、正式构建、真实 JSONL 恢复及 Session、Harness、Loop、工具聚焦测试通过。
