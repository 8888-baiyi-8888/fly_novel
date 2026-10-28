#### 真实 Agent Loop 插件

**目标**：参考 DeepSeek Harness 的 Agent Loop 设计，以管理完整 Agent Turn 的真实 Loop 作为 Harness 的执行实现。

Agent Loop 作为 Harness 的执行协调层，负责 Turn 生命周期、Step 执行控制、上下文组织、LLM 调用协调、Session 事件记录及最终结果返回，并为后续工具调用循环预留扩展能力。

第一阶段实现最小可运行闭环：一个 Turn 只执行一个 Step，该 Step 完成一次不带工具的模型请求。通过当前 Agent 实例的 Session、SystemPrompt 和 LLM 服务完成上下文组装、模型调用和结果记录。

后续在不改变 Turn 基本执行契约的前提下，逐步扩展为支持多个 Step、工具调用和完整 ReAct 循环的 Agent Loop。工具注册、工具权限及工具执行能力仍由后续独立插件开发阶段负责。

**开发主线：**

1. **官方 Loop 职责与执行流程**：阅读 DeepSeek Harness 官方 Agent Loop 的设计与实现，明确 Turn、Step、LLM Call 的概念和关系。结合当前 `AgentLoop`、`AgentInstance.run()` 和 Preset，梳理一次 `agent.run({ prompt })` 的完整调用路径。本步只理解职责和现有接口，不修改代码。

2. **Turn 执行契约**：确定 Loop 的输入、输出及 Turn 的生命周期，包括开始、执行、完成、失败和取消。明确 Turn 与 Step 的关系，以及 Loop 如何管理执行过程。核对现有 `AgentLoopInput`、`AgentLoopResult` 等契约，优先复用已有类型，不提前建立复杂的状态管理框架。

3. **独立 Loop 包与 Cordis 插件注册**：在 `src/agents/plugins/loop/` 建立独立工作区包 `@fly-novel/agent-loop`，明确入口文件、公共导出、依赖及构建配置。实现 Cordis 插件注册，将 `agentLoop` 服务提供给当前 Agent Context，声明对 Session、SystemPrompt 和 LLM 服务的依赖。通过最小示例验证插件能够注册、获取服务及正确卸载，不执行真实模型请求；Agents 包只负责注册，不转导 Loop Runtime。

4. **Turn 与 Step 最小执行闭环**：在真实 Loop 中实现最小 Turn 执行流程，一个 Turn 只执行一个 Step，先使用固定结果模拟 Step 执行。通过现有 Agent 和 Preset 完成 `agent.run()` → Loop → Turn → Step → Result 的实际调用，验证插件装配及结果返回。

5. **LLM 服务接入与模型调用**：让 Step 通过当前 Agent Context 的 LLM 服务完成一次无工具模型请求。模型由 `agent-loop-runtime` 插件配置中的 `provider` 与 `model` 选择；请求只包含当前 user 输入，成功时汇总文本块并返回，LLM 失败、取消、工具调用或未完成响应作为失败传播。通过固定模型适配器验证模型调用、路由和返回结果。Session 消息历史与 SystemPrompt 组装留待后续步骤。

6. **Session 接入与多轮对话**：通过 `session.deriveMessages()` 获取历史消息；Turn 开始后记录当前 user 输入，模型以 `stop` 成功结束后记录 assistant 回复。模型失败时保留已提交的 user 输入，不写入 assistant 消息。生命周期驱动函数从 Loop 运行阶段读取当前状态，不接收重复的 Turn 参数。验证同一 Agent 连续调用能够使用前轮历史，不同 Agent 的 Session 相互隔离。

7. **SystemPrompt 接入与上下文组装**：通过当前 Agent Context 的 `assemble()` / `renderPrompt()` 获取动态系统提示词，将系统提示词快照、Session 历史和当前用户输入统一组装为模型请求。Session 事件保留每次提示词快照，派生模型历史只投影最新非空 system 消息并放在历史开头；空快照清除旧提示词。验证多轮提示词更新不会重复发送旧快照，并检查提示词渲染失败时按 Turn 错误结束。

8. **Turn 生命周期与执行控制**：完善 Turn 的执行状态、终止条件、错误传播、取消和资源清理。`Agent.cancel()` 中止活动模型请求并拒绝尚未开始的排队调用；活动 Turn 记录 aborted 结束原因。Agent 销毁先取消并等待 Loop 收尾，再销毁 Session 和插件作用域。同一 Agent 的并发调用按提交顺序串行执行，验证取消后的新调用仍可运行。保持 Step 执行结构可扩展，但暂不引入工具循环、自动重试、复杂调度器或历史压缩。

9. **完整集成与端到端验收**：通过现有 Preset 装配真实 Loop、Session、SystemPrompt 和 LLM 插件，验证 `agent.run()` 到 Turn 执行、模型调用、Session 记录及最终结果返回的完整流程。检查独立包的构建、导出、Cordis 注册、依赖解析与插件卸载行为。固定模型适配器作为常规测试方式；本地配置可用时，再使用一个真实模型验证。**已完成**：角色和导演 Preset 均装配真实 Loop；固定适配器覆盖 Harness 和生命周期测试，真实 DeepSeek 调用成功。移除旧 mock loop 插件及生产导出，Harness 调试入口改用本地模型配置。

**开发要求：**

每一步沿用学习型开发方式：先核对官方对应实现，说明该步解决的问题、最简单的使用示例、输入输出及预期行为；确认后实现最小功能并实际验证；最后对照官方实现解释异同，完成后停止，等待下一步指示。

整个开发过程以 **Turn 为核心、Step 为执行单元、LLM Call 为具体模型请求**。第一版只支持一个 Turn 执行一个无工具 Step，后续逐步扩展为多 Step 和工具调用循环，不提前开发尚未使用的抽象与机制。
