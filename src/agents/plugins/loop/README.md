# @fly-novel/agent-loop

`@fly-novel/agent-loop` 为 Cordis Agent Context 提供 Agent Loop 契约与 Runtime 插件，入口为 `index.ts`。本包不创建 Agent Harness，也不读取应用配置或凭据。

## 契约与插件

`AgentLoop.run({ prompt })` 执行一次 Turn，并返回 `{ content }`。`agentLoopRuntimePlugin` 通过 Cordis `inject` 声明依赖 `sessions`、`systemPrompt` 和 `llm`，并在当前 Context 提供 `agentLoop`。装配该插件的 Preset 必须同时装配这些服务的提供插件；Agent 作用域销毁时 Cordis 会移除 Loop 服务，Session、SystemPrompt 和 LLM 提供插件分别释放其资源。

Runtime 从当前 Context 的 `sessions` 创建并持有 Session，通过私有 `turn()` 和 `step()` 记录运行事件。当前 Step 使用固定结果返回输入，只用于验证 Turn 执行契约；不调用 SystemPrompt 或 LLM。模型请求、Session 消息历史和提示词组装按开发计划后续步骤接入。

```ts
import { AgentLoopRuntime, agentLoopRuntimePlugin } from '@fly-novel/agent-loop'
```

Harness 插件注册定义由 `agentLoopRuntimePluginDefinition` 导出，负责装配的 `@fly-novel/agents` 包将其加入内置插件表。mock loop 属于 Harness 测试替身，仍由 `@fly-novel/agents` 提供。

本包采用 CommonJS，与仓库 workspace 包保持一致。运行 `pnpm --filter @fly-novel/agent-loop typecheck` 检查源码，运行 `pnpm --filter @fly-novel/agent-loop build` 生成 `dist/`。
