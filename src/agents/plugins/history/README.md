# @fly-novel/history

历史事件版本 1 格式和事件图校验。字段、世界时间及兼容策略见[历史资料契约](../../../../docs/workflows/word-initialization/world-initialization-stage-6a-history-contract.md)。本包当前不提供文件存储、查询工具、Agent 或角色认知权限。

`parseHistoryEvent` 和 `formatHistoryEvent` 校验单份 JSON；`validateHistoryEventGraph` 针对调用方提供的完整同世界事件集合校验上级及事件关系目标存在、事件 ID 唯一和上级无环。该检查不读取文件，不核验人物、组织和地点引用，也不推断时间或因果。
