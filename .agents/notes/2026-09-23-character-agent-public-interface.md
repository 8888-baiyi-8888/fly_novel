# CharacterAgent 对外调用接口

问题：角色 Agent 需要先提供稳定、最小的外部创建和运行入口，而模型、记忆、存储和 Deep Agents 运行时尚未实现。

决定：`CharacterAgent` 接收 `modelId`、小说与角色定位，并提供 `run({ scene, outputRequirements }, { signal? })`。`modelId` 是应用注册模型的标识，应用启动时通过 `configureAgentRuntime` 注册模型解析器；构造函数校验身份标识，保留不可变配置供调用方检查。源码按 `core/`、`runtime/` 和四个模板目录划分；共享的 `runDeepAgent` 接收已解析模型对象并执行一次 Deep Agents 调用，拒绝所有文件读写权限。

影响：调用方可以按最终调用形态调用角色模型，但当前只向模型传递序列化的场景与输出要求，并返回 Deep Agents 原始运行状态。角色提示、记忆、结构化结果校验和持久化保持未接入状态；导演、写作和评估后续复用共享运行时，不跨目录依赖角色实现。

验证：角色 Agent 测试覆盖身份保存、空标识拒绝和未接入运行时的拒绝路径；运行包类型检查、构建与项目测试。
