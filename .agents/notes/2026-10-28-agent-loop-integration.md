# Agent Loop 集成验收

## 问题

真实 Agent Loop 已作为独立工作区包实现，需要确认它能由 Harness Preset 装配，并和 Session、SystemPrompt、LLM 路由及 Agent 生命周期一起工作。

## 决定

- Harness 仍由 Preset 选择 Loop；角色和导演默认继续使用 mock loop。集成验证从现有角色 Preset 派生一个配置，仅将 mock loop 换成真实 Runtime，并保留其余角色插件。
- 常规端到端检查使用固定 LLM 适配器，验证 `agent.run()`、模型请求路由、Turn 完成、Session 消息和返回结果；单独保留已配置的真实 DeepSeek 调用作为外部集成检查。
- `@fly-novel/agent-loop` 维持独立公共入口；`@fly-novel/agents` 负责插件注册与 Preset 装配，不转导 Loop Runtime。

## 影响与验证

新增角色 Preset 集成用例。构建 LLM、Session、SystemPrompt、Agent Loop 和 Agents 包并编译测试；Agent Loop 测试文件 12 项全部通过，其中真实 DeepSeek 请求成功。当前 Loop 每个 Turn 仅执行一个无工具 Step；工具调用、多 Step 与重试仍属于后续开发。
