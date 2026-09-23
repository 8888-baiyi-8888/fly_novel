# 应用配置与依赖组装

## 一级子目录

| 子目录 | 作用 |
| --- | --- |
| tests/ | 应用入口与命令行交互测试。 |

`character-agent-example.ts` 是角色 Agent 的手动调试入口。它读取本机 DeepSeek 配置和已加密凭据，创建 OpenAI 兼容的 LangChain 模型，注册 Agent 运行时后执行一次角色调用。该入口只输出 Deep Agents 的原始结果，不保存角色状态或记忆。运行前按[配置模块说明](../config/README.md)准备 `settings.json`、`.credentials.json` 和 `.encryption-key`，再在仓库根目录执行：

```bash
pnpm run character-agent-example
```

在 VS Code 中调试时，打开“运行和调试”，选择“调试 CharacterAgent 模型调用”并按 F5。启动配置会先构建项目，再在集成终端运行样例，因此可以在 `character-agent-example.ts`、`CharacterAgent` 和共享运行时代码中设置断点。
