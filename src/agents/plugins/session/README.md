# @fly-novel/session

`@fly-novel/session` 为 Harness Agent 提供进程内只追加事件日志。设计顺序见[开发计划](../../../../docs/development-plan.md#session-插件开发)，插件形态对照官方 [`@deepseek-ai/dsh-session`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/session)。

## Session 基础类

`Session` 代表一个 Agent 会话，保存 Session ID、创建时间和按追加顺序排列的事件。ID 可由调用方提供，缺省时生成 UUID。`append(type, data)` 的事件类型限定为 `SessionEventMap` 的键，并由键推导对应负载；事件自动获得连续序号和写入时间。追加时会复制并深度冻结负载，避免调用方事后修改历史；`read()` 返回只读历史切片，支持排他游标 `afterIndex` 与数量限制 `limit`。关闭后清空内存事件并拒绝读写，重复关闭安全。

`SessionEventMap` 按 DeepSeek Harness 的声明合并方式允许插件扩展。基础类型区分 `turn/start`、`step/start` 等运行事件，以及 `user/message`、`assistant/message`、`tool/result` 等消息事件；消息负载复用 `@fly-novel/llm` 类型。助手消息内容中的 `tool-call` 块保留模型工具调用，独立的 `tool/call` 和 `tool/result` 事件记录执行过程。`SessionMessageEvent` 标明可参与后续模型消息派生的事件类别，本包当前不执行派生。会话数据不写入文件或数据库，进程重启后不恢复。

## Session Manager

`SessionManager` 提供 `create(id?)`、`get(id)`、`list()` 和 `close(id)`。省略 ID 时由 Session 生成 UUID；重复 ID 在同一 Manager 中会报错。`close(id)` 移除并关闭指定 Session，`closeAll()` 幂等关闭 Manager 内所有会话。Manager 关闭后拒绝继续创建。

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
const history = session.read()
```
