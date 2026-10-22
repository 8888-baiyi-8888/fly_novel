# @fly-novel/session

本目录是 Harness 通用内存 Session 插件的独立 pnpm 工作区包。开发顺序见[长期开发计划中的 Session 插件开发](../../../../docs/development-plan.md#session-插件开发)。当前只有包入口和构建配置，没有 Session 行为、插件注册定义或 Preset 绑定。

## 与 DeepSeek Harness 的对应关系

参考官方 [`@deepseek-ai/dsh-session`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/session)：它在内存中管理会话事件日志，并从事件派生模型消息。本包沿用项目的 CommonJS 工作区包配置；其他插件需要使用 Session 时，通过 `@fly-novel/session` 导入其后续公开的契约或插件定义。

| 官方 Session 包 | 本项目后续归属 |
| --- | --- |
| `src/index.ts`：插件入口与 Session 管理服务 | `index.ts`：包公共入口；后续导出插件定义与服务 |
| `src/types.ts`：会话、事件等类型 | 后续的 Session 契约；模型消息沿用 [`@fly-novel/llm` 的消息类型](../../../llm/message.ts) |
| `src/surface.ts`：从事件派生消息视图 | 后续的消息历史派生逻辑 |

存储介质读写和跨进程恢复属于后续独立的 Session 持久化插件。实现插件定义后，`@fly-novel/agents` 再将它纳入内置插件列表，供需要的 Preset 选择；包入口导入本身不注册插件。
