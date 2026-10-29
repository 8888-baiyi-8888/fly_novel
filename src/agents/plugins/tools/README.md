# 工具插件源码来源

## 与 DeepSeek Harness 的对应关系

以[固定上游版本的工具包说明](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/README.md)为对照：两者均通过 `defineTool` 定义工具、通过 `ctx.tools.register` 注册，校验输入和输出，将规范值渲染为模型内容，并可按调用 ID 在 Session 中关联调用与结果。普通工具错误作为结果返回，不必结束整个 Turn。

本项目的 Tools 服务按 Agent 实例隔离，Loop 直接将其 schema 传给模型；上游使用作用域注册表、工具选择和独立执行器。本项目将可信调用方提供的 `workingDirectory` 放入执行上下文，并由 `read_file` 限定目录；这属于项目自己的文件访问约束。批次当前按顺序串行执行，Session 保存在内存。授权审批、动态可见性、执行策略流水线、MCP、PTC、超时和重试、并发调度、工具 UI 及后台任务不属于当前实现。

工具执行上下文包含当前调用的 `callId`、工具 `name`、取消信号和调用方提供的授权工作目录。通过 Harness 装配的 Tools 插件从 Agent 作用域获取不可变的 Agent 身份快照；独立构造 `ToolsService` 时身份可省略。工具注册和模型可见性按 Agent 的 Tools 服务隔离，目录访问范围由可信调用方提供的 `workingDirectory` 限定；Agent 身份不代替目录授权。

`ToolsService.execute` 按输入顺序串行执行批次，按调用 ID 返回结果。可选的 `log` 包含 Session、Turn 和 Step，使服务在工具开始前记录 `tool/call` 并在结束后记录 `tool/result`；未开始且因取消跳过的调用只记录取消结果。独立调用不提供 `log` 时不写 Session。

`log.checkpoint` 由 Loop 提供时，在记录 `tool/call` 后、调用工具前等待持久化刷新；刷新失败时工具不会执行。

`@fly-novel/tools` 是独立工作区包，公开工具定义、ToolsService 和 Cordis 插件。Harness Preset 按插件 ID `tools` 装配服务，具体工具由调用方注册。

`@fly-novel/tools` 是独立工作区包，公开工具定义、ToolsService 和 Cordis 插件。Harness Preset 按插件 ID `tools` 装配服务，具体工具由调用方注册。

`schema.ts` 和 `json-schema.ts` 移植自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/src)，固定提交 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`，使用 [MIT 许可证](LICENSE.deepseek)。

本地替换 LLM 错误和 JSON 值工具的导入；`defineTool` 适配项目的工具契约与工作目录上下文，尚未引入展示、策略和执行器扩展。更新时对照上游源码重新应用这些调整，并运行工具定义、执行、服务和文件读取测试。
