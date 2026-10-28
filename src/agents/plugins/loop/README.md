# @fly-novel/agent-loop

`@fly-novel/agent-loop` 为 Cordis Agent Context 提供 Agent Loop 契约与 Runtime 插件，入口为 `index.ts`。本包不创建 Agent Harness，也不读取应用配置或凭据。

## 契约与插件

`AgentLoop.run({ prompt })` 执行一次 Turn，并返回 `{ content }`。`agentLoopRuntimePlugin` 通过 Cordis `inject` 声明依赖 `sessions`、`systemPrompt` 和 `llm`，并在当前 Context 提供 `agentLoop`。装配该插件的 Preset 必须同时装配这些服务的提供插件；Agent 作用域销毁时 Cordis 会移除 Loop 服务，Session、SystemPrompt 和 LLM 提供插件分别释放其资源。

Runtime 从当前 Context 的 `sessions` 创建并持有 Session。`run({ prompt })` 是输入边界；无参数的 `turn()` 驱动当前 Turn，无参数的 `step()` 执行其中一个模型步骤，活动输入和序号保存在 Loop 的运行阶段状态中。Preset 需在 `agent-loop-runtime` 配置中指定 `provider` 和 `model`。Step 开始后通过当前 Context 的 `systemPrompt.assemble()` 和 `renderPrompt()` 生成提示词，将非空提示词快照及 user 消息写入 Session，再通过 `session.deriveMessages()` 取得模型历史。Session 派生视图始终把最新 system 提示词放在历史开头，避免多轮请求重复发送旧快照；空提示词快照清除之前的系统提示词。Context 的 `llm.stream()` 发起无工具请求。Step 保留流返回的完整内容块；仅在 `stop` 时记录带 provider、model 和 replay state 的 assistant 消息，并从文本块生成 `{ content }`。模型错误、取消、工具调用和未完成响应均作为失败传播，失败输入保留在 Session 中且不生成 assistant 消息。

`agent.cancel()` 中止当前 Step 的 `AbortSignal`，拒绝等待队列中的 Turn，并使活动 Turn 以 `{ kind: 'aborted', reason: 'user' }` 结束。Agent 销毁时先调用 Loop 的 `dispose()`，中止活动请求、拒绝排队输入并等待 Turn 写入结束事件，再释放插件作用域和 Session。多个 `run()` 按提交顺序串行执行；取消不影响之后提交的新调用。

## Harness Preset 装配

角色和导演 Preset 均装配 `agent-loop-runtime`、`session`、`system-prompt` 和 `llm`。创建 Agent 时，`pluginConfigs['agent-loop-runtime']` 指定模型路由，例如 `{ provider: 'deepseek', model: 'deepseek-chat' }`；`pluginConfigs.llm` 提供该 provider 对应的适配器。成功运行按 `turn/start`、`step/start`、可选 `system/message`、`user/message`、`assistant/message`、`step/end`、`turn/end` 顺序写入 Session；失败时保留已写入的提示词快照和 `user/message`，不写入 `assistant/message`。

```ts
import { AgentLoopRuntime, agentLoopRuntimePlugin } from '@fly-novel/agent-loop'
```

Harness 插件注册定义由 `agentLoopRuntimePluginDefinition` 导出，负责装配的 `@fly-novel/agents` 包将其加入内置插件表。Agent Loop 测试使用固定适配器验证模型交互，不提供生产 mock loop 插件。

本包采用 CommonJS，与仓库 workspace 包保持一致。运行 `pnpm --filter @fly-novel/agent-loop typecheck` 检查源码，运行 `pnpm --filter @fly-novel/agent-loop build` 生成 `dist/`。
