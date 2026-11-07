# 文件观察策略的会话归属和事件路由

问题：文件事件共用 Cordis 总线，直接移植上游监听器会截获其他 Agent 的意图；工具上下文原先不携带 Session。

决定：Loop 显式传递 Session，Tools 暴露稳定身份；策略按身份匹配，仅对当前 SessionManager 持有且活动的 Session 记录观察，其他身份委派。策略随作用域清理，不进入生产 Preset。

影响：工具执行契约新增可选 Session，恢复和 Fork 创建的 Session 不继承观察；事件参与方仍须主动传递保护，策略不提供授权。

验证：以真实 Harness 测试多 Agent 路由和作用域释放，工具集成测试检查 Loop 传递的 Session；文件后端和完整状态表留待后续步骤。
