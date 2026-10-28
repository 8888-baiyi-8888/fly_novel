# Agent Loop 取消与销毁

## 问题

Agent Loop 串行处理同一 Agent 的 Turn，但缺少取消入口和活动模型请求的清理规则。Agent 插件并行卸载时，Session 可能在 Loop 记录结束事件前关闭。

## 决定

- `Agent.cancel()` 委托当前 Loop 取消活动 Turn，并拒绝尚未开始的排队调用；后续新调用仍可运行。
- 每个活动 Turn 持有自己的 `AbortController`，信号传给 LLM 请求；取消结束原因为 `aborted/user`。
- `AgentInstance.dispose()` 在 Cordis 作用域销毁前等待 Loop `dispose()`，使活动请求先取消并完成 Session 收尾。Loop 插件的 effect cleanup 再次调用幂等 `dispose()`。
- 同一 Agent 的并发 `run()` 按提交顺序执行；取消时队列中的未开始调用被拒绝，不产生 Turn 事件。

## 影响与验证

Agent Loop 契约新增 `cancel()` 与 `dispose()`。测试覆盖活动请求取消、排队调用拒绝、Turn aborted 记录、销毁等待及销毁后 Agent 状态；Session 在 Loop 清理完成后关闭。
