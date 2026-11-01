# 应用配置与依赖组装

`agent_harness.ts` 提供 Cordis Harness 的独立调试函数 `debugAgentHarness(prompt)`，按角色 Preset 创建 Agent、读取本机 DeepSeek 配置并调用真实 Agent Loop，最后销毁实例。在仓库根目录运行 `pnpm run agent-harness-debug -- "你明天会回来吗？"`，或在 VS Code“运行和调试”中选择“调试 Cordis Agent Harness（DeepSeek）”并按 F5。该调试配置先构建 Agent 包和应用，可在函数、`AgentInstance.run()` 和 `AgentLoopRuntime` 中设置断点。

`writer-agent-example.ts` 和 `audit-censor-agent-example.ts` 使用本地模型及凭据配置，分别调用写作、审计和内容审查 Agent；运行前按[配置模块说明](../config/README.md)准备配置和凭据，也可用命令行参数选择 `settings.json` 中的提供商：

```bash
pnpm run writer-agent-example [provider]
pnpm run audit-censor-agent-example [provider]
```

## 一级子目录

| 子目录 | 作用 |
| --- | --- |
| tests/ | 应用入口与命令行交互测试。 |
