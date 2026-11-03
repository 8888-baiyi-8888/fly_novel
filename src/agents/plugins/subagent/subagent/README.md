# @fly-novel/subagent

本包定义一次性 SubAgent 委派的公开契约。`SubagentStartRequest` 携带父 Agent 的最小身份视图、任务原文和取消信号；现有 Agent 实例满足该视图，核心包无需依赖 `@fly-novel/agents`。

Provider 在启动成功并发布运行后返回 `SubagentRun`，调用方负责处理 `result` 并最终调用 `dispose()`。发布前的失败清理由 Provider 负责；发布后取消信号作用于该运行的剩余工作。运行标识由 Provider 在父 Agent 范围内分配，调用 `subagentRunId()` 创建，不能与 Agent 标识混用。

任务成功、失败或取消通过结果的 `stopReason` 表达；无法表达为任务终态的基础设施故障可以使 `result` 拒绝。`dispose()` 可重复调用，等待剩余任务停止和资源释放。

`SubagentRuntime` 提供具名 Provider 注册、查询和启动。`registerProvider()` 拒绝空名称和重复名称，返回可重复调用的注销函数；`getProvider()` 在未注册时返回 `undefined`，`list()` 按注册顺序返回名称。`start(name, request)` 按名称调用 Provider，返回已启动运行的句柄；Provider 不存在或启动失败时拒绝。运行标识的唯一性由 Provider 在父 Agent 范围内保证，服务不维护已交付运行的登记表。

`dispose()` 清空注册、取消并等待尚未交付的启动；重复调用等待同一次关闭。若 Provider 在取消后仍返回句柄，服务处理其结果拒绝并释放句柄；释放失败会报告给启动调用方和关闭调用方。Provider 在发布前必须响应取消并清理资源，否则关闭须等待其启动结算。注册注销和服务关闭不会释放已交付的运行，句柄仍由调用方负责。服务关闭后的注册、查询和启动会报错。旧注销函数不会移除后续同名注册。

`subagentPlugin` 在当前 Cordis 作用域提供 `subagents` 服务；插件销毁时等待服务关闭。Harness 注册定义的 ID 是 `subagent`，由 Preset 显式选择。Provider 插件可通过 `inject: ['subagents']` 取得同一服务，并用 Cordis Effect 管理注册。不同 Agent 的服务与注册表相互隔离；插件不自动注册 Provider。实际子 Agent 执行见后续[核心服务开发计划](../../../../../docs/modules/agents/subagent-core-development-plan.md)。
