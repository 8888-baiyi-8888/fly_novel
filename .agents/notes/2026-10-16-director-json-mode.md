# Director Agent 按调用启用原生 JSON 模式

## 问题

章节 direct 节点需要 Dispatch JSON，但输出格式属于调用方要求；DirectorAgent 的普通调用应继续保留自由文本能力。格式化调用也必须经过已有 Deep Agent 实例，不能绕过 Agent 直接调用模型或为每次调用重建 Agent。

## 决定

`DirectorAgent.generate` 接收可选 Zod schema。提供 schema 时，调用方把 schema 写入提示词并通过本次 invoke 的 configurable 标记 JSON 模式；Deep Agent 中间件只对该次模型请求设置模型原生 `response_format: { type: "json_object" }`，并关闭工具调用。Agent 返回后由调用方 schema 校验结构。未提供 schema 时，使用原有 Agent 调用路径。

## 影响与验证

章节 direct 节点传入 Dispatch schema，schema 校验失败时按 direct 重试；之后继续执行既有 Dispatch 业务闸门。`pnpm run build` 和 `git diff --check` 通过。未发起真实模型调用。
