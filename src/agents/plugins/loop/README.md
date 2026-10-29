# @fly-novel/agent-loop

`@fly-novel/agent-loop` 为 Cordis Agent Context 提供 Agent Loop 契约与 Runtime 插件，入口为 `index.ts`。本包不创建 Agent Harness，也不读取应用配置或凭据。

## 契约与插件

`AgentLoop.run({ prompt })` 执行一次 Turn，并返回 `{ content }`。`agentLoopRuntimePlugin` 通过 Cordis `inject` 声明依赖 `sessions`、`systemPrompt` 和 `llm`，并在当前 Context 提供 `agentLoop`。装配该插件的 Preset 必须同时装配这些服务的提供插件；Agent 作用域销毁时 Cordis 会移除 Loop 服务，Session、SystemPrompt 和 LLM 提供插件分别释放其资源。

Runtime 从当前 Context 的 `sessions` 创建并持有 Session。`run({ prompt })` 对应一个 Turn，`step()` 负责模型请求。配置需要 `provider` 和 `model`；有可见工具时还需由调用方提供 `workingDirectory` 作为授权工作目录。Loop 从 `systemPrompt` 和 Session 组装请求，将可见工具 schema 传给 LLM；模型返回工具调用时，Tools 服务按模型顺序串行执行并记录各调用和结果，再从 Session 派生历史进入下一 Step。单个工具失败不阻止后续调用；取消时等待已启动工具结束，并为尚未启动的调用记录取消结果。

Loop 配置可指定 `sessionId` 新建持久化会话，或指定 `resumeSessionId` 恢复已有会话；两个字段互斥，必须通过应用装配 `sessionPersistence` 后端。新建遇到已存在的 ID、恢复遇到不存在的 ID 时拒绝创建 Agent。不指定这两个字段时使用原有内存会话。恢复时为未结束的 Turn 补齐缺失工具结果、Step 和 `interrupted` Turn 结束事件，再重建 Session；已记录开始而无结果的工具标为结果未知，不自动重试。未记录开始的调用只有在会话声明工具检查点时才标为未开始，否则保守标为结果未知。可通过 `agent.context.sessions.list()` 获取当前 Session ID。Agent 销毁时等待 Session 关闭和写句柄释放。调试步骤见[持久化调试](../../../../docs/cookbook/session-persistence-debug.md)。


`maxSteps` 是每个 Turn 的模型 Step 上限，必须为正整数，默认 10。最后允许的 Step 若返回工具调用，先完成并记录当前批次，再以 `MAX_STEPS` 错误结束 Turn；Session 记录 `{ kind: 'max-steps', maxSteps }`，不发起下一次模型请求。最后允许的 Step 若返回最终文本则正常结束。

`agent.cancel()` 中止当前 Step 的 `AbortSignal`，拒绝等待队列中的 Turn，并使活动 Turn 以 `{ kind: 'aborted', reason: 'user' }` 结束。Agent 销毁时先调用 Loop 的 `dispose()`，中止活动请求、拒绝排队输入并等待 Turn 写入结束事件，再释放插件作用域和 Session。多个 `run()` 按提交顺序串行执行；取消不影响之后提交的新调用。

工具结果的模型可见内容写入 Session；失败时附带结构化错误名称和错误码。工具调用写入后如结果缺失，Loop 在 Step 结束前补写错误结果：尚未记录开始使用 `TOOL_NOT_STARTED`，已记录开始但结果未知使用 `TOOL_OUTCOME_UNKNOWN`。已有结果不重复补写；服务返回的调用 ID 不匹配时拒绝结果并补写原调用的未知结果。进程重启后的恢复见上文。

工具结果的模型可见内容写入 Session；失败时附带结构化错误名称和错误码。工具调用写入后如结果缺失，Loop 在 Step 结束前补写错误结果：尚未记录开始使用 `TOOL_NOT_STARTED`，已记录开始但结果未知使用 `TOOL_OUTCOME_UNKNOWN`。已有结果不重复补写；服务返回的调用 ID 不匹配时拒绝结果并补写原调用的未知结果。进程重启后的恢复见上文。

## Harness Preset 装配

角色和导演 Preset 均装配 `agent-loop-runtime`、`session`、`system-prompt` 和 `llm`。创建 Agent 时，`pluginConfigs['agent-loop-runtime']` 指定模型路由，例如 `{ provider: 'deepseek', model: 'deepseek-chat' }`；`pluginConfigs.llm` 提供该 provider 对应的适配器。需要工具时在 Preset 添加 `tools`，注册工具，并为 Loop 配置可信的 `workingDirectory`；工具失败结果也记录到 Session 并交给下一次模型请求。

```ts
import { AgentLoopRuntime, agentLoopRuntimePlugin } from '@fly-novel/agent-loop'
```

Harness 插件注册定义由 `agentLoopRuntimePluginDefinition` 导出，负责装配的 `@fly-novel/agents` 包将其加入内置插件表。Agent Loop 测试使用固定适配器验证模型交互，不提供生产 mock loop 插件。

本包采用 CommonJS，与仓库 workspace 包保持一致。运行 `pnpm --filter @fly-novel/agent-loop typecheck` 检查源码，运行 `pnpm --filter @fly-novel/agent-loop build` 生成 `dist/`。
