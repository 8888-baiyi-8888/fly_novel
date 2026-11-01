# 移除旧角色 Agent

问题：角色目录同时保留 Deep Agents 角色实现和 Cordis Harness 角色 Preset，旧入口依赖独立的档案读取和 SQLite 会话。

决定：移除旧角色类、管理器及其专属提示词、会话、类型、读取工具、测试和调试入口；保留 Harness 角色 Preset 与插件。

影响：不删除或转换已有角色档案和 SQLite 会话数据库；Harness 不自动读取或迁移旧会话。其他 Deep Agents 模板继续使用原有基类。

验证：工作区类型检查、构建、测试编译、角色提示词和 Harness 聚焦测试。
