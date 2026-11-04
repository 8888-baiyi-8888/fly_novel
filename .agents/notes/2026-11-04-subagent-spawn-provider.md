# 进程内 Spawn Provider 注册

## 问题

委派服务需要一个独立 Provider，将调用方选择的 Preset 和任务交给共享 Driver，并保持父 Agent 插件作用域隔离。

## 决定

新增 Spawn 插件，在当前 Subagent 服务注册 `spawn`，使用可信装配提供的创建函数。通用请求增加可选 `presetId`，Spawn 要求提供格式有效的标识；其他 Provider 可自行决定是否使用。创建函数负责实际 Preset 校验和资源创建，当前步骤只用受控函数验证，不提供生产创建装配。

## 影响与验证

插件卸载注销 Provider，已交付 Run 仍由调用方释放。使用固定替身验证标识和任务传递、非法请求、不同 Agent 作用域、插件配置失败及重复释放；相关核心服务和 Driver 集成测试一并运行。
