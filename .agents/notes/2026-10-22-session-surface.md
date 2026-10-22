# Session 消息 Surface

- 问题：Session 事件日志包含运行过程记录，模型请求需要一份只含消息且顺序稳定的历史视图。
- 决定：Session 内部维护消息事件序号组成的追加式 Surface；`deriveMessages()` 沿 Surface 导出模型消息。Surface 当前不提供替换、检索或压缩操作。
- 影响：原始事件日志继续保留运行记录；模型上下文只包含 system/user/assistant/tool-result 消息，空助手消息不导出。后续可在 Surface 上扩展消息替换等视图操作，而无需改变事件日志职责。
- 验证：Session 包类型检查、测试编译和 Session 聚焦测试通过；`git diff --check` 通过。
