# Harness LLM 服务插件

## 问题

现有 LLM 模块提供 Cordis 服务和适配器路由，但 Harness 的插件注册表尚未提供按 Agent 实例装配该服务的定义。

## 决定

在 `src/agents/plugins/llm/` 增加装配插件，并加入现有内置插件注册表。需要模型服务的 Agent 由自己的 Preset 选择插件，实例配置提供适配器。插件在当前 Agent 的 Context 中创建 `LlmRuntime`，用 Cordis effect 持有路由注销函数。现有 mock Preset 不选择 LLM。

## 影响

每个装配 LLM 的 Agent 拥有自己的服务和路由；销毁 Agent 或插件启动失败时，所属作用域清理路由。Harness 启动入口、工厂、Manager 和 mock loop 保持现有契约。

## 验证

通过 Harness 测试核对插件注册、配置拒绝、实例作用域与路由清理，并构建工作区。显式启用的 Harness 真实用例通过 Agent 的插件服务向本机配置的 DeepSeek 发起请求；模型返回“连接成功”。
