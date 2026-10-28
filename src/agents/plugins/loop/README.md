# @fly-novel/agent-loop

`@fly-novel/agent-loop` 为 Cordis Agent Context 提供 Agent Loop 契约与 Runtime 插件，入口为 `index.ts`。本包不创建 Agent Harness，也不读取应用配置或凭据。

## 契约与插件

`AgentLoop.run({ prompt })` 执行一次 Turn，并返回 `{ content }`。`agentLoopRuntimePlugin` 通过 Cordis `inject` 声明依赖 `sessions`、`systemPrompt` 和 `llm`，并在当前 Context 提供 `agentLoop`。装配该插件的 Preset 必须同时装配这些服务的提供插件；Agent 作用域销毁时 Cordis 会移除 Loop 服务，Session、SystemPrompt 和 LLM 提供插件分别释放其资源。

Runtime 从当前 Context 的 `sessions` 创建并持有 Session。`run({ prompt })` 对应一个 Turn，`step()` 负责模型请求。配置需要 `provider` 和 `model`；有可见工具时还需由调用方提供 `workingDirectory` 作为授权工作目录。Loop 从 `systemPrompt` 和 Session 组装请求，将可见工具 schema 传给 LLM；模型返回一个工具调用时，记录 assistant、tool/call 与关联的 tool/result，再从 Session 派生历史进入下一 Step。模型返回最终文本时结束 Turn。当前每次响应只接受一个工具调用，不限制 Turn 的 Step 数；多个调用会被拒绝。模型错误、取消和未完成响应以错误传播。

`agent.cancel()` 中止当前 Step 的 `AbortSignal`，拒绝等待队列中的 Turn，并使活动 Turn 以 `{ kind: 'aborted', reason: 'user' }` 结束。Agent 销毁时先调用 Loop 的 `dispose()`，中止活动请求、拒绝排队输入并等待 Turn 写入结束事件，再释放插件作用域和 Session。多个 `run()` 按提交顺序串行执行；取消不影响之后提交的新调用。

## Harness Preset 装配

角色和导演 Preset 均装配 `agent-loop-runtime`、`session`、`system-prompt` 和 `llm`。创建 Agent 时，`pluginConfigs['agent-loop-runtime']` 指定模型路由，例如 `{ provider: 'deepseek', model: 'deepseek-chat' }`；`pluginConfigs.llm` 提供该 provider 对应的适配器。需要工具时在 Preset 添加 `tools`，注册工具，并为 Loop 配置可信的 `workingDirectory`；工具失败结果也记录到 Session 并交给下一次模型请求。

```ts
import { AgentLoopRuntime, agentLoopRuntimePlugin } from '@fly-novel/agent-loop'
```

Harness 插件注册定义由 `agentLoopRuntimePluginDefinition` 导出，负责装配的 `@fly-novel/agents` 包将其加入内置插件表。Agent Loop 测试使用固定适配器验证模型交互，不提供生产 mock loop 插件。

本包采用 CommonJS，与仓库 workspace 包保持一致。运行 `pnpm --filter @fly-novel/agent-loop typecheck` 检查源码，运行 `pnpm --filter @fly-novel/agent-loop build` 生成 `dist/`。
