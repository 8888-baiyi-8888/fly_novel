# @fly-novel/director-system-prompt

导演 Agent 的专有 Cordis 提示词插件，依赖通用 `systemPrompt` 服务，在当前 Agent 作用域注册导演职责提示词；作用域销毁时注销。故事任务、世界规则和当前局势由调用输入提供。提示词引导导演规划父故事和当前子故事，区分事实、发展方向与未知，并保留角色自主选择；规划建议不代表故事已发生。本包提供 Harness 注册定义，导演 Preset 按插件 ID 装配，不提供资料读取或角色调用能力。

在仓库根目录执行：

```bash
pnpm --filter @fly-novel/director-system-prompt typecheck
pnpm --filter @fly-novel/director-system-prompt build
```
