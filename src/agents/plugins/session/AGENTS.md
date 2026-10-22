# Session 包开发提示

- 本目录是 `@fly-novel/session` 独立工作区包。动手前阅读[开发顺序](../../../../docs/development-plan.md#session-插件开发)、[本包说明](README.md)及相关源码。
- 参考官方 `@deepseek-ai/dsh-session` 的职责实现通用内存 Session；遵循本项目的 CommonJS 包构建与 Cordis 插件约定。
- 当前范围按顺序为：会话创建与事件追加/读取、消息与事件类型、多个 Session 的管理、模型消息历史派生。模型消息类型复用 `@fly-novel/llm`；会话事件与模型消息保持区分。
- 存储介质读写、跨进程恢复、长历史检索和压缩留到长期计划第 7 项；持久化使用独立插件。基础关闭与资源释放随 Session 管理实现。
- 插件定义从本包入口导出，由 `src/agents/plugins/index.ts` 汇总，再由需要的 Preset 选择。测试放在 `src/agents/tests/`，通过根项目测试编译入口运行。
- Session 插件开发应尽可能遵从 DeepSeek Harness 官方实现。若官方实现与本项目现有约定冲突，或遵从它会带来较大的额外负担，应暂停受影响的实现并先询问用户；经用户决定后再继续。
