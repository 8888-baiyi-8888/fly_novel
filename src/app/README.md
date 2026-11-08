# 应用配置与依赖组装

`agents/` 分别提供世界初始化主 Agent、角色 Agent、导演 Agent 和写作 Agent 的创建函数。各创建函数从本机 DeepSeek 配置创建适配器，以当前工作目录为授权目录，并按各自工具列表逐项注册；单项失败时记录错误并继续创建。每次创建独立实例，调用方使用完毕后调用返回的 `agent.dispose()`。世界初始化主 Agent 使用当前目录下 `src/agents/world-initialization-main-agent/skills`，要求以仓库根目录启动；Skill 样例不随构建自动复制。

`createWorldInitializationAgentWithWorkspace` 接收可信应用显式指定的现有 `viewRoot`、`draftRoot` 和 `confirmedRoot` 绝对目录；创建前校验其真实路径与可写范围。它注册文件、搜索和委派工具，主 Agent 只能修改草稿根，子 Agent 只读；已确认根不能与上游平台临时可写根重叠。内置 Skill 来源单独授权，Skill 正文可加载，但其资源路径不会因此自动成为文件工具的读取范围。该入口要求以仓库根目录启动，并适用于可信本地工作区；路径检查不能抵御恶意并发替换或硬链接。它不实现世界资料确认和持久化流程。

`agent_harness.ts` 提供 Cordis Harness 的独立调试函数 `debugAgentHarness(prompt)`，按角色 Preset 创建 Agent、读取本机 DeepSeek 配置并调用真实 Agent Loop，最后销毁实例。在仓库根目录运行 `pnpm run agent-harness-debug -- "你明天会回来吗？"`，或在 VS Code“运行和调试”中选择“调试 Cordis Agent Harness（DeepSeek）”并按 F5。该调试配置先构建 Agent 包和应用，可在函数、`AgentInstance.run()` 和 `AgentLoopRuntime` 中设置断点。

`world-initialization-debug.ts` 使用本机 DeepSeek 配置创建世界初始化主 Agent，在集成终端中直接输入并显示 Agent 回复；输入 `/exit` 结束。运行 `pnpm run world-initialization-debug`，或在 VS Code“运行和调试”选择“调试世界初始化主 Agent（DeepSeek）”并按 F5。调试入口以仓库为工作目录，使用仓库中的玄幻 Skill 样例；真实请求需要有效的模型配置和网络。此入口只测试 Agent 对话，不实现程序控制的确认和超时。

`writer-agent-example.ts` 使用本地模型及凭据配置调用写作 Agent；运行前按[配置模块说明](../config/README.md)准备配置和凭据，也可用命令行参数选择 `settings.json` 中的提供商：

```bash
pnpm run writer-agent-example [provider]
```

## 一级子目录

| 子目录 | 作用 |
| --- | --- |
| agents/ | 各种 Agent 的应用层创建入口。 |
| tests/ | 应用入口与命令行交互测试。 |
