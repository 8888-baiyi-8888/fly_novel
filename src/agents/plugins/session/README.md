# @fly-novel/session

`@fly-novel/session` 为 Harness Agent 提供进程内只追加事件日志。设计顺序见[开发计划](../../../../docs/development-plan.md#session-插件开发)，插件形态对照官方 [`@deepseek-ai/dsh-session`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/session)。

## Session 基础类

`Session` 代表一个 Agent 会话，保存 Session ID、创建时间和按追加顺序排列的事件。ID 可由调用方提供，缺省时生成 UUID。`append(type, data)` 的事件类型限定为 `SessionEventMap` 的键，并由键推导对应负载；事件自动获得连续序号和写入时间。追加时会复制并深度冻结负载，避免调用方事后修改历史；`read()` 返回只读历史切片，支持排他游标 `afterIndex` 与数量限制 `limit`。关闭后清空内存事件并拒绝读写，重复关闭安全。

`SessionEventMap` 按 DeepSeek Harness 的声明合并方式允许插件扩展。基础类型区分 `turn/start`、`step/start` 等运行事件，以及 `user/message`、`assistant/message`、`tool/result` 等消息事件；消息负载复用 `@fly-novel/llm` 类型。助手消息内容中的 `tool-call` 块保留模型工具调用，独立的 `tool/call` 和 `tool/result` 事件记录执行过程。

`tool/result` 保存工具结果消息，并可保存失败的结构化名称与错误码；模型历史只包含消息内容，不包含事件的错误元数据。派生模型历史时检查工具调用与结果的 ID 配对，缺失、错配或重复会抛错。

`tool/result` 保存工具结果消息，并可保存失败的结构化名称与错误码；模型历史只包含消息内容，不包含事件的错误元数据。派生模型历史时检查工具调用与结果的 ID 配对，缺失、错配或重复会抛错。

`Session` 内部的 Surface 按顺序保存消息事件在事件日志中的序号。`deriveMessages()` 将最新的非空 system 消息置于历史开头，其余 user、assistant 和 tool result 消息按写入顺序导出；空 system 消息用于清除先前提示词，不进入模型上下文。turn/step 等运行事件及独立的 `tool/call` 记录不进入模型上下文，空助手消息也会被跳过。每次调用返回新的消息数组，历史事件中的消息快照保持不可变。Surface 只追加事件，不执行历史检索或压缩。调用方可用已验证的持久化事件作为 `create(id, { seed, createdAt })` 的种子恢复 Session；种子按原序号重建 Surface，不发布为新事件，工具消息不配对时恢复失败。

## Session Manager

`SessionManager` 提供 `create(id?, options?)`、`get(id)`、`list()`、`flush(session)` 和异步 `close(id)`。省略 ID 时由 Session 生成 UUID；重复 ID 在同一 Manager 中会报错。持久化后端接收 `session/event`，`flush(session)` 等待 `session/flush` 监听器；`close(id)` 禁止追加并等待刷新及 `session/disposed` 后关闭，失败时保留会话供重试。`closeAll()` 异步关闭 Manager 内所有会话，失败时报告错误；关闭后拒绝继续创建。

## Harness 插件

`sessionPluginDefinition` 使用项目 `AgentPluginDefinition` 注册契约，Cordis 插件通过 `provide: 'sessions'` 在 Agent Context 提供 `SessionManager`，使用方式与官方 `ctx.sessions` 对应。Harness 为每个 Agent 隔离该服务；Manager 的所有权属于装配它的 Agent 插件作用域，Agent 销毁时自动关闭该 Agent 的全部 Session。Session ID 在 Manager 内唯一，Agent ID 通过 Manager 所属的 Agent Context 关联，不重复存入 Session。

```ts
const agent = await manager.create({ id: 'writer-1', presetId: 'writer-preset' })
const sessions = agent.context.get('sessions')
const session = sessions.create('writer-conversation-1')
session.append('user/message', {
  id: messageId,
  role: 'user',
  content: [{ type: 'text', text: '继续这一幕' }],
  source: { kind: 'user' },
})
const events = session.read()
const modelHistory = session.deriveMessages()
```
