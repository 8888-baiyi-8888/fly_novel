# Session 事件类型

- 问题：基础 Session 允许任意字符串事件类型和任意对象负载，调用方无法区分运行事件与模型消息，也无法按事件类型获得负载类型。
- 决定：采用 DeepSeek Harness 的可扩展 `SessionEventMap` 判别联合；事件通过 `append(type, data)` 写入，消息负载复用 `@fly-novel/llm`，插件事件通过声明合并扩展。
- 影响：事件保存连续序号和写入时间；Session 暴露消息事件子集供后续历史派生使用，但当前不执行派生。`@fly-novel/session` 增加 `@fly-novel/llm` 工作区依赖。
- 验证：通过 Session 包构建、根项目测试编译及 Session/Harness 聚焦测试。
