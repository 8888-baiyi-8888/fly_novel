# 小说创作项目源码

自动化测试放在所属一级模块的 `tests/` 中，例如 `app/tests/`、`config/tests/`；更深的源码子目录共用所属一级模块的测试目录。存在测试时创建目录，正式构建排除测试。

## 一级子目录

| 子目录 | 作用 |
| --- | --- |
| [agents/](agents/README.md) | 独立工作区包 `@fly-novel/agents`，承载写作 Agent 的公共入口与实现；其 `plugins/loop/` 是独立工作区包 `@fly-novel/agent-loop`。 |
| [app/](app/README.md) | 应用入口、模型配置组装、凭据命令与 Agent 示例。 |
| [config/](config/README.md) | 固定应用数据路径、配置校验与本地凭据加密存储。 |
| [llm/](llm/README.md) | 大语言模型调用接口与提供商适配。 |
| [tools/](tools/README.md) | 可直接调用的具体工具实现。 |
| [util/](util/README.md) | 跨模块共用的基础工具。 |
