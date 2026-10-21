# Cordis Agent Harness V1

问题：Agent 需要可替换的外部能力，以及独立的插件服务与生命周期；已有 Deep Agents 业务实现需要继续可用。

决定：在 `@fly-novel/agents` 包中增加 Cordis `Context`、插件 ID 映射、Preset 注册表、工厂、实例 handle 和 Manager。每个 Agent 必须装配提供 `agentLoop` 服务的插件；`Agent.run()` 只转发执行请求，不实现循环。角色与导演 Preset 装配 mock loop、memory 插件。服务和依赖分别使用 Cordis 插件的 `provide`、`inject` 声明，每个实例隔离所需服务，并以一个 Cordis 父 Fiber 持有子插件。包仍构建为 CommonJS，bootstrap 动态导入 ESM 版 `@deepseek-ai/cordis`，因此返回 Promise。

影响：消费者通过 `await bootstrapAgents()` 创建 Harness，通过 `agent.run()` 执行，按需经 `agent.context.get()` 读取其他插件服务，并在结束时调用 Manager 销毁；`Agent.state` 从父 Fiber 状态派生。原 Deep Agents 业务入口继续保留。插件初始化失败时清理已创建的 Fiber，不把实例加入 Manager。

验证：使用包和根项目的 TypeScript 配置检查；运行 `src/agents/tests/harness.test.ts` 验证装配、隔离、失败清理和销毁。
