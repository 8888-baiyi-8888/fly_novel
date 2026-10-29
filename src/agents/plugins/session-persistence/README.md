# @fly-novel/session-persistence

本包定义 Cordis `sessionPersistence` 服务、会话句柄和头部契约。JSONL 后端位于 [Agents 包](../session-persistence-jsonl/index.ts)；Session 和 Agent Loop 消费该独立契约，不依赖 Agents 包。

服务提供 `create`、`open`、`stat`、`list` 和 `flush`；句柄提供 `read`、`append`、`flush` 和 `close`。字段和失败约定见导出类型。实际耐久性由后端提供，本包不执行文件读写。
