# 进程内子 Agent 任务结果映射

## 问题

Driver 从 Agent.run() 获取文本或异常，需要区分模型任务失败、取消与无法安全归类的基础设施错误，不能丢失持久化等聚合错误。

## 决定

正常返回映射为 completed 和原文输出；LlmError 的 ABORTED 映射为 aborted，其他 LlmError 映射为 error 并仅保留稳定错误码。未知异常及 AggregateError 原样通过 result 拒绝；句柄清理失败由 dispose 报告。Driver 接收的任务文本不额外拼接提示词。

## 影响与验证

SubagentResult 增加可选错误码，调用方不能从结果取得 LLM 异常消息。模拟 Agent 测试覆盖正常、空输出、任务错误、取消、聚合异常和同时清理失败；真实 Manager 集成以及完整取消和清理竞争仍待后续步骤。
