# 应用配置与依赖组装

`agents/` 分别提供世界初始化主 Agent、角色 Agent、导演 Agent 和写作 Agent 的创建函数。各创建函数从本机 DeepSeek 配置创建适配器，以当前工作目录为授权目录，并按各自工具列表逐项注册；单项失败时记录错误并继续创建。每次创建独立实例，调用方使用完毕后调用返回的 `agent.dispose()`。世界初始化主 Agent 使用当前目录下 `src/agents/world-initialization-main-agent/skills`，要求以仓库根目录启动；Skill 样例不随构建自动复制。

`agent_harness.ts` 提供 Cordis Harness 的独立调试函数 `debugAgentHarness(prompt)`，按角色 Preset 创建 Agent、读取本机 DeepSeek 配置并调用真实 Agent Loop，最后销毁实例。在仓库根目录运行 `pnpm run agent-harness-debug -- "你明天会回来吗？"`，或在 VS Code“运行和调试”中选择“调试 Cordis Agent Harness（DeepSeek）”并按 F5。该调试配置先构建 Agent 包和应用，可在函数、`AgentInstance.run()` 和 `AgentLoopRuntime` 中设置断点。

`world-initialization-debug.ts` 使用本机 DeepSeek 配置创建世界初始化主 Agent，在集成终端中多轮输入；输入 `/exit` 结束。运行 `pnpm run world-initialization-debug`，或在 VS Code“运行和调试”选择“调试世界初始化主 Agent（DeepSeek）”并按 F5。调试入口以仓库为工作目录，使用仓库中的玄幻 Skill 样例；真实请求需要有效的模型配置和网络。此入口只调试当前 Agent，不提供确认超时等业务流程。

`writer-agent-example.ts` 使用本地模型及凭据配置调用写作 Agent；运行前按[配置模块说明](../config/README.md)准备配置和凭据，也可用命令行参数选择 `settings.json` 中的提供商：

```bash
pnpm run writer-agent-example [provider]
```

## 一级子目录

| 子目录 | 作用 |
| --- | --- |
| agents/ | 各种 Agent 的应用层创建入口。 |
| tests/ | 应用入口与命令行交互测试。 |
