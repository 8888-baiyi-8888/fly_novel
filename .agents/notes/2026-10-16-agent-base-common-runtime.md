# BaseAgent 统一 Agent 创建与文本调用

## 问题

多个 Agent 子类重复创建 Deep Agent，并重复把文本包装为 user message 调用；不同模板同时需要保留自己的线程、检查点和输出处理方式。

## 决定

`BaseAgent` 统一创建 Deep Agent 和基础文本调用。子类通过构造参数传入模型、系统提示词及框架选项。角色线程配置和导演结构化输出仍由对应 Agent 管理，不扩展为基类策略。

## 影响与验证

角色、导演、写作、审计和内容审查 Agent 复用基类执行入口；`CharacterAgentManager` 与模板职责不变。通过 `pnpm --filter @fly-novel/agents build`、`pnpm run build` 和 `git diff --check` 验证。
