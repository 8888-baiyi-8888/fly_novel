# Agent Loop 包开发提示

- 本目录是 `@fly-novel/agent-loop` 独立工作区包。动手前阅读[开发计划](../../../../docs/development-plan.md#真实-agent-loop-插件)、[本包说明](README.md)及相关源码。
- 参考 DeepSeek Harness 官方 [`@deepseek-ai/dsh-agent-loop`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent-loop) 的包边界、Turn/Step 职责与 Cordis 插件方式；按本项目计划逐步实现，不提前接入后续阶段能力。
- 本包依赖 Cordis 与 `@fly-novel/session`，不依赖 `@fly-novel/agents`。AgentLoop 契约归本包；Harness 注册表与 Preset 由 `@fly-novel/agents` 维护。
- SystemPrompt 和 LLM 通过 Cordis `inject` 声明为服务依赖；提供者由宿主 Harness Preset 装配。本包不读取模型配置或凭据。
- 包入口、导出和构建配置保持独立；跨包导入使用 `@fly-novel/agent-loop` 公共入口。测试位于 `src/agents/tests/`，由仓库测试编译入口运行。
