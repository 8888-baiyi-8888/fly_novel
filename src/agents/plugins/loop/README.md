# @fly-novel/agent-loop

`@fly-novel/agent-loop` 为 Cordis Agent Context 提供 Agent Loop 契约与 Runtime 插件，入口为 `index.ts`。本包不创建 Agent Harness，也不读取应用配置或凭据。

## 契约与插件

`AgentLoop.run({ prompt })` 执行一次 Turn，并返回 `{ content }`。`agentLoopRuntimePlugin` 通过 Cordis `inject` 声明依赖 `sessions`、`systemPrompt` 和 `llm`，并在当前 Context 提供 `agentLoop`。装配该插件的 Preset 必须同时装配这些服务的提供插件；Agent 作用域销毁时 Cordis 会移除 Loop 服务，Session、SystemPrompt 和 LLM 提供插件分别释放其资源。

Runtime 从当前 Context 的 `sessions` 创建并持有 Session，通过私有 `turn()` 和 `step()` 记录运行事件。Preset 需在 `agent-loop-runtime` 配置中指定 `provider` 和 `model`，Step 将当前输入作为单条 user 消息，通过 Context 的 `llm.stream()` 发起无工具请求。Runtime 汇总文本增量，在 `stop` 结束原因时返回；模型错误、取消、工具调用和未完成响应均作为失败传播。当前请求不包含 Session 历史或 SystemPrompt，这两项按开发计划后续步骤接入。

## Harness Preset 装配

Preset 选择 `agent-loop-runtime` 时，还需选择 `session`、`system-prompt` 和 `llm` 服务插件，并配置模型路由，例如 `{ provider: 'deepseek', model: 'deepseek-chat' }`。运行期间按 `turn/start`、`step/start`、`step/end`、`turn/end` 顺序写入 Session；需要回显前缀时，Preset 可改选由 `@fly-novel/agents` 提供的 `mock-loop`。

```ts
import { AgentLoopRuntime, agentLoopRuntimePlugin } from '@fly-novel/agent-loop'
```

Harness 插件注册定义由 `agentLoopRuntimePluginDefinition` 导出，负责装配的 `@fly-novel/agents` 包将其加入内置插件表。mock loop 属于 Harness 测试替身，仍由 `@fly-novel/agents` 提供。

本包采用 CommonJS，与仓库 workspace 包保持一致。运行 `pnpm --filter @fly-novel/agent-loop typecheck` 检查源码，运行 `pnpm --filter @fly-novel/agent-loop build` 生成 `dist/`。
