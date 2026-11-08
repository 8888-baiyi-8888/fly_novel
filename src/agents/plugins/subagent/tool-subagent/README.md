# @fly-novel/tool-subagent

可信装配可通过 `presetId` 配置指定已注册且已在 Spawn 创建器中授权的子 Agent Preset；缺省使用 `generic-subagent`，模型不能通过工具参数选择 Preset。

`toolSubagentPlugin` 在当前 Agent 作用域注册 `delegate` 工具，依赖同作用域的 `agent`、`tools` 和 `subagents` 服务；初始化时要求 `spawn` Provider 已注册。工具卸载时注销，Provider 后续被注销时启动请求会失败，工具不会自动消失。

模型传入非空 `task`；工具将原文交给 `spawn`，使用可信装配允许的 `generic-subagent` Preset。子 Agent 不继承父会话，模型需要在任务中提供必要上下文。工具前台等待任务结果并释放运行；失败和取消作为工具错误返回。任务和清理同时失败时保留两个错误。

使用方需要给父 Agent 装配 `tools`、`subagent`、`subagent-spawn-in-process` 和 `tool-subagent`，并为 Spawn 提供允许创建 `generic-subagent` 的可信配置。父 Agent Loop 暴露工具时需要可信 `workingDirectory`；子 Agent 的模型适配器和路由由创建方提供。此包不实现角色专用工具、后台任务或自动结果通知。
