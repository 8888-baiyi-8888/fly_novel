# Agent 运行框架

## 一级子目录

| 子目录 | 作用 |
| --- | --- |
| [agent/](agent/README.md) | Agent 定义、运行状态和模型与工具的执行循环。 |
| [model/](model/README.md) | 大语言模型的请求、响应和能力接口。 |
| [tools/](tools/README.md) | 工具定义、注册、输入校验和执行。 |
| [context/](context/README.md) | 运行消息组装、上下文预算和压缩。 |
| [orchestration/](orchestration/README.md) | 多 Agent 委派、父子运行和结果汇总。 |
| [execution/](execution/README.md) | 取消、超时、执行额度和资源清理。 |
| [approval/](approval/README.md) | 人工确认请求及批准、拒绝结果的处理。 |
| [events/](events/README.md) | 运行事件定义、投递和订阅。 |
| [persistence/](persistence/README.md) | Agent 运行记录和检查点的存储接口。 |
| [adapters/](adapters/README.md) | 模型服务和运行存储的具体接入实现。 |
