# @fly-novel/subagent-in-process-driver

本包定义进程内一次性子 Agent 运行驱动的创建契约；当前只导出类型，尚未提供可执行的 Driver。

`InProcessAgentCreator` 由调用方提供，接收 SubAgent 启动请求，返回 `InProcessAgentHandle`。句柄包含运行标识、可执行和取消任务的 Agent，以及由创建方负责的释放操作；例如通过 Manager 创建 Agent 的适配方负责调用同一 Manager 移除实例。创建失败时创建方先回滚未交付资源；创建成功交付后 Driver 负责释放句柄。

`InProcessRunDriver` 表达启动请求和创建能力到 `SubagentRun` 的边界。启动成功和任务完成是不同时间点；成功、失败和取消的具体映射、取消传播与资源清理须由后续实现和测试确定。

创建方可以通过自己的闭包准备创建配置和未来的初始上下文，Driver 不固定这些配置的结构。此契约不提供 Fork 历史导入、Session 装配、模型继承或真实 Provider。开发顺序见[共享运行驱动开发计划](../../../../../docs/modules/agents/subagent-in-process-driver-development-plan.md)。
