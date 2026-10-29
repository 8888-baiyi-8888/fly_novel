# 工具插件源码来源

工具执行上下文包含当前调用的 `callId`、工具 `name`、取消信号和调用方提供的授权工作目录。通过 Harness 装配的 Tools 插件从 Agent 作用域获取不可变的 Agent 身份快照；独立构造 `ToolsService` 时身份可省略。工具注册和模型可见性按 Agent 的 Tools 服务隔离，目录访问范围由可信调用方提供的 `workingDirectory` 限定；Agent 身份不代替目录授权。

`@fly-novel/tools` 是独立工作区包，公开工具定义、ToolsService 和 Cordis 插件。Harness Preset 按插件 ID `tools` 装配服务，具体工具由调用方注册。

`@fly-novel/tools` 是独立工作区包，公开工具定义、ToolsService 和 Cordis 插件。Harness Preset 按插件 ID `tools` 装配服务，具体工具由调用方注册。

`schema.ts` 和 `json-schema.ts` 移植自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/src)，固定提交 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`，使用 [MIT 许可证](LICENSE.deepseek)。

本地替换 LLM 错误和 JSON 值工具的导入；`defineTool` 适配项目的工具契约与工作目录上下文，尚未引入展示、策略和执行器扩展。更新时对照上游源码重新应用这些调整，并运行工具定义、执行、服务和文件读取测试。
