# 小说创作工作流与 Agent 运行系统

自动化测试放在所属一级模块的 `tests/` 中，例如 `app/tests/`、`config/tests/`；更深的源码子目录共用所属一级模块的测试目录。存在测试时创建目录，正式构建排除测试。

## 一级子目录

| 子目录 | 作用 |
| --- | --- |
| [app/](app/README.md) | 读取配置并组装应用依赖和实例。 |
| [config/](config/README.md) | 固定应用数据路径、配置校验与本地凭据加密存储。 |
| [llm/](llm/README.md) | 大语言模型调用接口与提供商适配。 |
| [util/](util/README.md) | 跨模块共用的基础工具。 |
| [harness/](harness/README.md) | 通用 Agent 运行框架。 |
| [workflow/](workflow/README.md) | 通用图工作流引擎。 |
| [novel/](novel/README.md) | 小说数据、业务规则和写作流程。 |
