# @fly-novel/session-persistence

本包定义 Cordis `sessionPersistence` 服务、会话句柄和头部契约。JSONL 后端位于 [Agents 包](../session-persistence-jsonl/index.ts)；Session 和 Agent Loop 消费该独立契约，不依赖 Agents 包。

服务提供 `create`、`open`、`stat`、`list` 和 `flush`；句柄提供 `read`、`append`、`flush` 和 `close`。字段和失败约定见导出类型。实际耐久性由后端提供，本包不执行文件读写。

## 与 DeepSeek Harness 对照

对照的官方版本为 [`f3803c9` 的持久化契约](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/session/session-persistence/README.md)和 [JSONL 后端](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/session/session-persistence-jsonl/README.md)。两者均以服务和会话句柄分离后端操作，按顺序保存事件，通过刷新和关闭完成写入，并可恢复会话继续运行。

本项目使用自身 Session 事件和未压缩 JSONL v2，不能直接读取官方存储格式；官方后端默认使用带校验的 Zstandard 压缩。本项目在 Agent Loop 处理未完成 Turn 的恢复，并以已记录的工具开始状态区分未开始与结果未知；不自动重复可能有副作用的工具。本项目会同步文件内容，但不承诺目录项在断电后持久化。

同一会话的并发打开和写入、恢复时模型或提示词变化、长历史检索与上下文压缩、其他后端及旧 SQLite 数据迁移均不在当前计划内。Session ID 与业务角色的对应关系由调用方管理。具体开发范围见 [Session 扩展计划](../../../../docs/modules/agents/session-extension-development-plan.md)。
