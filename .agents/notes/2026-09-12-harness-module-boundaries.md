# Harness 模块边界

## 问题

Harness 的初始目录按通用技术层划分，Agent 接口与执行循环混合，部分宽泛目录与工作流职责容易重叠。

## 决定

Harness 参考 DeepSeek Harness 的能力模块命名，将 Agent 接口与 Agent Loop 分离，并使用 `llm`、`session`、`session-persistence`、`system-prompt`、`subagent` 和 `user-approval` 等具体模块名称。本地会话存储使用独立的 `session-persistence-jsonl` 模块。

## 影响

`agent` 管理 Agent 接口和生命周期，`agent-loop` 驱动模型与工具循环；会话事件及持久化拥有明确归属。小说业务继续位于 `novel`，图工作流继续位于 `workflow`。

## 验证

核对 `src/harness/README.md` 中的一级子目录与实际目录一致，并执行 Markdown 链接和空白检查。
