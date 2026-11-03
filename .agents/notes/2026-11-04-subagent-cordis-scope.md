# SubAgent Cordis 作用域

## 问题

子 Agent 委派服务需要与 Provider 在同一作用域协作，并在 Agent 关闭时处理尚未交付的启动。

## 决定

将 Subagent 服务作为可选的 Agent 作用域插件注册；Preset 显式选择服务，Provider 插件通过依赖注入注册，作用域销毁时等待服务关闭。每个 Agent 持有独立注册表；已交付运行仍由调用方负责。

## 影响与验证

内置插件表包含 subagent，但现有 Preset 不自动装配该服务。Cordis 集成测试验证两个 Agent 的隔离、模拟委派以及关闭时等待迟到句柄清理；真实子 Agent 的创建和运行不属于本次变更。

Cordis 的 effect 清理错误不会自动传给 Agent 销毁调用方，因此 Agent 显式等待自身装配的 subagents 服务关闭并汇报错误；不关闭从根 Context 继承的同名服务。集成测试覆盖清理失败及根服务不受影响。
