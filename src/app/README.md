# 应用配置与依赖组装

`director-agent-example.ts` 从本地配置读取所选模型提供商、API 地址和加密凭据，创建模型后调用 `DirectorAgent`。默认提供商为 `deepseek`，也可将 settings.json 中的提供商名作为命令行参数传入。运行前按[配置模块说明](../config/README.md)准备 `settings.json`、`.credentials.json` 和 `.encryption-key`，再在仓库根目录执行 `pnpm run director-agent-example` 或 `pnpm run director-agent-example <provider>`。

## 一级子目录

| 子目录 | 作用 |
| --- | --- |
| tests/ | 应用入口与命令行交互测试。 |

`character-agent-example.ts` 是角色 Agent 的手动调试入口。它读取本机 DeepSeek 配置和已加密凭据，创建关闭思考模式的 OpenAI 兼容 LangChain 模型，注册运行时后连续执行两轮角色调用并打印 `structuredResponse`。样例在调用处定义 Zod Schema：首轮为 `dialogue`、`action`，第二轮为 `reply`，这些字段不是 Agent 内置约束。模型必须调用结构化输出工具，同一实例保留记忆历史。DeepSeek 思考模式不接受强制工具选择。运行前按[配置模块说明](../config/README.md)准备 `settings.json`、`.credentials.json` 和 `.encryption-key`，再在仓库根目录执行：

```bash
pnpm run character-agent-example
```

在 VS Code 中调试时，打开“运行和调试”，选择“调试 CharacterAgent 模型调用”并按 F5。启动配置会先构建项目，再在集成终端运行样例，因此可以在 `character-agent-example.ts`、`CharacterAgent` 和共享运行时代码中设置断点。
