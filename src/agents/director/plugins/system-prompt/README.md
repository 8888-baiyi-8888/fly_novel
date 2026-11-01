# @fly-novel/director-system-prompt

导演 Agent 的专有 Cordis 提示词插件，依赖通用 `systemPrompt` 服务，在当前 Agent 作用域注册导演职责提示词；作用域销毁时注销。创作目标、世界规则和人物状态由调用输入提供。本包提供 Harness 注册定义，导演 Preset 按插件 ID 装配。

在仓库根目录执行：

```bash
pnpm --filter @fly-novel/director-system-prompt typecheck
pnpm --filter @fly-novel/director-system-prompt build
```
