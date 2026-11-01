# 世界初始化主 Agent 提示词插件

问题：世界初始化主 Agent 需要专有提示词，同时复用已有 SystemPrompt 服务与 Harness 生命周期。

决定：在主 Agent 的 plugins/system-prompt 下建立独立工作区包，专属插件注册提示词段；Agents 包提供 Harness 注册定义。主 Agent Preset 和 Skill 工具留给后续阶段。

影响：插件依赖通用 SystemPrompt 服务，随作用域注销提示词；不改变用户确认或资料存储行为。

验证：工作区类型检查、测试编译及聚焦集成测试验证提示词进入模型请求、Agent 隔离和销毁清理。
