# Fork 历史快照与内存 Session 初始化

标准 Agent Loop 独占其运行使用的 Session，而 Session Manager 可以持有多个会话。按会话列表顺序寻找父会话无法证明它是当前 Loop 使用的会话。

标准 Loop 提供只读快照能力，从自身持有且仍由本作用域 Manager 管理的 Session 截取至最后一个已结束轮次。可信装配可将验证过的纯文本历史作为新内存 Session 的初始事件；该配置与持久化 ID 互斥。原 Session 和新 Session 各自复制事件，子实例使用自身的系统提示。

首版拒绝工具事件、私有重放状态、非文本消息和未知事件，避免静默破坏历史含义。Fork Provider 和父身份的作用域核验由后续步骤实现，当前配置不构成模型可调用的 Fork。

验证入口为 [Agent Loop 历史测试](../../src/agents/tests/agent-loop-fork-history.test.ts)，覆盖截取、独立会话、续写与不支持的历史拒绝。
