# @fly-novel/subagent

本包定义一次性 SubAgent 委派的公开契约。`SubagentStartRequest` 携带父 Agent 的最小身份视图、任务原文和取消信号；现有 Agent 实例满足该视图，核心包无需依赖 `@fly-novel/agents`。

Provider 在启动成功并发布运行后返回 `SubagentRun`，调用方负责处理 `result` 并最终调用 `dispose()`。发布前的失败清理由 Provider 负责；发布后取消信号作用于该运行的剩余工作。运行标识由 Provider 在父 Agent 范围内分配，调用 `subagentRunId()` 创建，不能与 Agent 标识混用。

任务成功、失败或取消通过结果的 `stopReason` 表达；无法表达为任务终态的基础设施故障可以使 `result` 拒绝。`dispose()` 可重复调用，等待剩余任务停止和资源释放。

`SubagentRuntime` 提供具名 Provider 注册和查询。`registerProvider()` 拒绝空名称和重复名称，返回可重复调用的注销函数；`getProvider()` 在未注册时返回 `undefined`，`list()` 按注册顺序返回名称。`dispose()` 清空注册并关闭服务；旧注销函数不会移除后续同名注册。注册注销和服务关闭不会释放已交付的运行，句柄仍由调用方负责。服务关闭后的注册和查询会报错。

服务启动路由、Cordis 插件和实际子 Agent 执行不属于本包当前入口。开发顺序见[核心服务开发计划](../../../../../docs/modules/agents/subagent-core-development-plan.md)。
