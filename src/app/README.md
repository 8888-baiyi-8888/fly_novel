# 应用配置与依赖组装

`agent_harness.ts` 提供 Cordis Harness 的独立调试函数 `debugAgentHarness(prompt)`，按角色 Preset 创建 Agent、执行 mock loop 并销毁实例；不读取模型配置或凭据。在仓库根目录运行 `pnpm run agent-harness-debug -- "你明天会回来吗？"`，或在 VS Code“运行和调试”中选择“调试 Cordis Agent Harness（mock）”并按 F5。该调试配置先用本地 TypeScript 编译器构建 Agent 包和应用，可在函数、`AgentInstance.run()` 和 mock loop 插件中设置断点。

`director-agent-example.ts` 从本地配置读取所选模型提供商、API 地址和加密凭据，创建模型后调用 `DirectorAgent`。默认提供商为 `deepseek`，也可将 settings.json 中的提供商名作为命令行参数传入。运行前按[配置模块说明](../config/README.md)准备 `settings.json`、`.credentials.json` 和 `.encryption-key`，再在仓库根目录执行 `pnpm run director-agent-example` 或 `pnpm run director-agent-example <provider>`。

`writer-agent-example.ts` 和 `audit-censor-agent-example.ts` 使用相同的本地模型及凭据配置，分别调用写作、审计和内容审查 Agent；也可用命令行参数选择 `settings.json` 中的其他提供商：

```bash
pnpm run writer-agent-example [provider]
pnpm run audit-censor-agent-example [provider]
```

## 一级子目录

| 子目录 | 作用 |
| --- | --- |
| [novel-workflow/](novel-workflow/workflow.ts) | 建书命令行入口：解析参数、创建真实或内存 Agent，并调用小说级 LangGraph；单步命令复用工作流节点。 |
| tests/ | 应用入口与命令行交互测试。 |

`character-agent-example.ts` 是角色 Agent 的手动调试入口。它通过 `chat-openai-model.ts` 读取本机 DeepSeek 配置和已加密凭据，创建关闭思考模式的 OpenAI 兼容 LangChain 模型，并调用角色 Agent。章节驱动入口 `run-chapters.ts` 使用同一模型工厂和凭据读取逻辑，将导演、写作、审计和内容审查 Agent 直接注入对应节点；只有 `merge` 和 `settle` 使用通用工作流 `AgentPort`。运行前按[配置模块说明](../config/README.md)准备 `settings.json`、`.credentials.json` 和 `.encryption-key`，再在仓库根目录执行：

```bash
pnpm run character-agent-example
```

在 VS Code 中调试时，打开“运行和调试”，选择“调试 CharacterAgent 模型调用”并按 F5。启动配置会先构建项目，再在集成终端运行样例，因此可以在 `character-agent-example.ts`、`CharacterAgent` 和共享运行时代码中设置断点。
