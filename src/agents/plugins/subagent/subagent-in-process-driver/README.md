# @fly-novel/subagent-in-process-driver

本包提供进程内一次性子 Agent 运行驱动和创建交接函数；子 Agent 的具体创建方式由调用方提供。

`InProcessAgentCreator` 由调用方提供，接收 SubAgent 启动请求，返回 `InProcessAgentHandle`。句柄包含运行标识、可执行和取消任务的 Agent，以及由创建方负责的释放操作；例如通过 Manager 创建 Agent 的适配方负责调用同一 Manager 移除实例。创建失败时创建方先回滚未交付资源；创建成功交付后 Driver 负责释放句柄。

`startInProcessRun(request, create)` 创建子 Agent，并将任务原文提交给 `agent.run()`；它返回 `SubagentRun`，调用方通过 `result` 等待任务完成，通过 `dispose()` 释放句柄。正常返回的 `content` 作为 `completed` 的 `output`，空内容仍为成功。

`LlmError` 的 `ABORTED` 映射为 `aborted`；其他 `LlmError` 映射为 `error`，只保留稳定的 `errorCode`，不将异常消息放入结果。其他异常（包括包含持久化失败的 `AggregateError`）通过 `result` 原样拒绝，由调用方处理；清理失败由 `dispose()` 报告。运行中的取消信号传给 Agent 的 `cancel()`，已完成结果不因后续取消改变。`dispose()` 的并发调用共享结果，等待任务和创建方的释放操作结束；取消入口与释放同时失败时以聚合错误报告。

`createInProcessAgent(request, create)` 在调用创建方前检查取消。创建期间取消时，函数等待创建结算；创建方返回句柄后，函数等待句柄释放再以取消原因拒绝。清理失败以 `SubagentStartupCleanupError` 同时保留取消原因和清理错误；创建方自身回滚失败时也使用该错误类型。创建成功返回句柄后，由调用方持有并负责释放；该函数不执行任务，也不在交付后监听取消。

创建方可以通过自己的闭包准备创建配置和未来的初始上下文，Driver 不固定这些配置的结构。此契约不提供 Fork 历史导入、Session 装配、模型继承或真实 Provider。开发顺序见[共享运行驱动开发计划](../../../../../docs/modules/agents/subagent-in-process-driver-development-plan.md)。

项目集成测试通过测试用 Provider、真实 Agent Factory / Manager 和固定模型适配器验证启动、结果、取消与释放；该测试 Provider 不属于生产装配。真实 Spawn 和 Fork Provider 需要在各自步骤完成。
