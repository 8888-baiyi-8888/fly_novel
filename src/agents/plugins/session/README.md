# @fly-novel/session

`@fly-novel/session` 为 Harness Agent 提供进程内只追加事件日志。设计顺序见[开发计划](../../../../docs/development-plan.md#session-插件开发)，插件形态对照官方 [`@deepseek-ai/dsh-session`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/session)。

## Session 基础类

`Session` 代表一个 Agent 会话，保存 Session ID、创建时间和按追加顺序排列的事件。ID 可由调用方提供，缺省时生成 UUID。`append(type, data)` 的事件类型限定为 `SessionEventMap` 的键，并由键推导对应负载；事件自动获得连续序号和写入时间。追加时会复制并深度冻结负载，避免调用方事后修改历史；`read()` 返回只读历史切片，支持排他游标 `afterIndex` 与数量限制 `limit`。关闭后清空内存事件并拒绝读写，重复关闭安全。

`SessionEventMap` 按 DeepSeek Harness 的声明合并方式允许插件扩展。基础类型区分 `turn/start`、`step/start` 等运行事件，以及 `user/message`、`assistant/message`、`tool/result` 等消息事件；消息负载复用 `@fly-novel/llm` 类型。助手消息内容中的 `tool-call` 块保留模型工具调用，独立的 `tool/call` 和 `tool/result` 事件记录执行过程。`SessionMessageEvent` 标明可参与后续模型消息派生的事件类别，本包当前不执行派生。会话数据不写入文件或数据库，进程重启后不恢复。

## Harness 插件

`sessionPluginDefinition` 使用项目 `AgentPluginDefinition` 注册契约，Cordis 插件通过 `provide: 'session'` 在 Agent Context 提供 `Session`。插件配置可传 `sessionId`；默认生成随机 UUID。每个 Agent 实例创建自己的 Session，Cordis 插件作用域销毁时关闭并释放历史。插件定义在 Harness 启动时注册，Preset 通过插件 ID `session` 选择装配。

```ts
const agent = await manager.create({ id: 'writer-1', presetId: 'writer-preset' })
const session = agent.context.get('session')
session.append('user/message', {
  id: messageId,
  role: 'user',
  content: [{ type: 'text', text: '继续这一幕' }],
  source: { kind: 'user' },
})
const history = session.read()
```

多个 Session 的创建和检索由后续 Manager 负责。
