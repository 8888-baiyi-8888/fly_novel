# @fly-novel/subagent-spawn-in-process

本包提供 Cordis 插件 `spawnInProcessPlugin`，在当前 `subagents` 作用域注册名为 `spawn` 的 Provider，并在插件作用域关闭时注销。Harness 注册定义 ID 是 `subagent-spawn-in-process`；使用它的 Preset 还需装配 `subagent`。

可信装配通过配置中的 `create` 提供 `InProcessAgentCreator`。`spawn` 启动请求必须包含非空、无首尾空白的 `presetId`；Provider 将请求交给共享 Driver，创建函数负责创建和释放子 Agent。Provider 不自行验证 Preset 是否注册或创建独立 Session，这些职责属于可信创建方；本包不提供生产用创建函数。

成功启动后调用方持有 Run，负责等待 `result` 并调用 `dispose()`；Provider 注销不会销毁已交付的运行。任务原文由 Driver 传给创建的 Agent，插件不追加提示词。
