# 移除旧导演 Agent

问题：导演目录同时保留 Deep Agents 导演实现和 Cordis Harness 导演 Preset。

决定：移除旧导演类、专属提示词和调试入口，保留 Harness 导演 Preset 与提示词插件。

影响：旧类提供的 JSON 输出中间件及调用入口不再可用；Harness 导演 Preset 不因此获得结构化输出能力。其他 Deep Agents 模板保留。

验证：工作区类型检查、构建、测试编译、导演提示词和 Harness 聚焦测试。
