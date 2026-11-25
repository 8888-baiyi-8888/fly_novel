# src 目录说明

## 仓库结构

- `README.md`：目录职责和使用说明。
- `agents/`：写作 Agent 工作区包；core/ 定义 Cordis Harness 实例与注册契约，runtime/ 管理装配和生命周期，plugins/ 提供 Harness 插件适配；Session、SystemPrompt 与 Agent Loop 分别位于独立工作区包；保留各业务 Agent 实现。
- `app/`：应用入口、业务装配和示例。
- `config/`：应用配置与凭据管理。
- `llm/`：工作区包 @fly-novel/llm。
- `tools/`：具体工具实现，测试放在 src/tools/tests/。
- `util/`：跨模块共用的基础工具，测试放在 src/util/tests/。
- `world-init/`：世界初始化业务能力目录，测试放在 src/world-init/tests/。
