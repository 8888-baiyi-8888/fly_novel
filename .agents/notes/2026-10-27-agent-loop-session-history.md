# Agent Loop Session 多轮历史

## 问题

Agent Loop 已能完成一次模型调用，但每次请求只带当前输入，Session 中也没有用户与助手消息，连续调用无法形成对话历史。

## 决定

- Turn 开始后将当前 user 消息追加到该 Agent 的 Session。
- `buildRequest()` 使用 `session.deriveMessages()` 作为模型消息序列，使前轮成功的 user/assistant 消息进入后续请求。
- 成功时从流的 `block-end` 收集完整内容块；LLM 以 `stop` 结束后，记录带 provider/model 和可选 replay state 的 assistant 消息，再从 text 块投影返回文本。
- 模型失败时保留已提交的 user 输入，不追加 assistant 消息；当前契约尚无取消信号，因此不引入取消事件处理。
- `run({ prompt })` 是输入边界；无参数 `turn()` 和 `step()` 从 Loop 运行阶段读取当前 Turn 状态。`kick()` 顺序驱动已排队输入，避免共享 Session 的并发写入交错。
- 新建消息由 `@fly-novel/llm` 的消息工厂分配标识并冻结；`freezeMessage()` 保留给已有标识消息的快照复制。System 消息记录插件来源；工具结果沿用本项目 user 角色中的 `tool-result` 内容块契约。
- 每个 Step 从当前 Agent Context 组装并渲染 SystemPrompt；非空提示词作为 `system/message` 快照写入 Session，提示词清空时写入空快照移除旧提示词。
- Session 的 `deriveMessages()` 将最新非空 system 消息放在历史开头，保留后续 user/assistant/tool 消息顺序；旧系统提示词只留在事件日志中，不重复进入模型请求。
- Agent Loop 包依赖独立的 `@fly-novel/system-prompt` 包，通过其公共 `renderPrompt()` API 生成模型提示词。

## 影响与验证

Loop 现在依赖 SystemPrompt 的组装与渲染，以及 Session 的消息事件和派生视图完成多轮上下文。测试检查提示词变化、空提示词清除、消息顺序、成功消息记录和失败时不产生 assistant 消息；真实模型用例检查 Session 中的消息角色。
