# Session Manager

- 问题：Session 基础类可单独创建，但没有统一入口管理多个会话，也没有明确会话与 Agent 的生命周期关系。
- 决定：增加 `SessionManager`，提供 `create/get/list/close/closeAll`。Harness 通过 `sessions` 服务暴露 Manager；每个 Agent 获得隔离实例，Manager 随 Agent 插件作用域销毁并关闭全部 Session。
- 影响：Session ID 在各自 Manager 内唯一；Session 不另存 Agent ID，归属由 Manager 所属的 Agent Context 表达。沿用官方 `ctx.sessions` 的创建、查询和列举形态，增加计划要求的显式关闭方法。
- 验证：Session 包类型检查与构建、测试编译、Session/Harness 聚焦测试及 `git diff --check`。
