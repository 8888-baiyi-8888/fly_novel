# 小说创作项目源码

自动化测试放在所属一级模块的 `tests/` 中，例如 `app/tests/`、`config/tests/`；更深的源码子目录共用所属一级模块的测试目录。存在测试时创建目录，正式构建排除测试。

## 一级子目录

| 子目录 | 作用 |
| --- | --- |
| [agents/](agents/README.md) | 独立工作区包 `@fly-novel/agents`，承载写作 Agent 的公共入口与实现。 |
| [app/](app/README.md) | 应用入口、模型配置组装、凭据命令与 Agent 示例。 |
| [config/](config/README.md) | 固定应用数据路径、配置校验与本地凭据加密存储。 |
| [llm/](llm/README.md) | 大语言模型调用接口与提供商适配。 |
| [util/](util/README.md) | 跨模块共用的基础工具。 |
| [workflow/](workflow/README.md) | 章节级与小说级 LangGraph 工作流，以及共用节点、Agent 和持久化契约。 |
| [novel-flow/](novel-flow/README.md) | 建书流程的 Agent、数据结构和工作区输出。 |
| [novel/](novel/README.md) | 小说领域数据模型、确定性校验、服务与运行时。 |
