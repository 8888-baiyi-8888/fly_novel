# 工具插件源码来源

`schema.ts` 和 `json-schema.ts` 移植自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/src)，固定提交 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`，使用 [MIT 许可证](LICENSE.deepseek)。

本地替换 LLM 错误和 JSON 值工具的导入；`defineTool` 适配项目的工具契约与工作目录上下文，尚未引入展示、策略和执行器扩展。更新时对照上游源码重新应用这些调整，并运行工具定义、执行、服务和文件读取测试。
