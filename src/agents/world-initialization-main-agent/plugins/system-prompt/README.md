# @fly-novel/world-initialization-system-prompt

世界初始化主 Agent 的专有 Cordis 提示词插件。插件依赖 `systemPrompt` 服务，在当前 Agent 作用域注册职责提示词；插件作用域销毁时注销该提示词。通用提示词的注册、组装和渲染由 [`@fly-novel/system-prompt`](../../../plugins/system-prompt/README.md) 提供。

本包提供插件注册定义，由 Agents 包的注册表汇总；世界初始化主 Agent 的内置 Preset 会装配该插件，创建方式见 [Agents 包说明](../../../README.md#创建世界初始化主-agent)。提示词指导按需读取、委派和整合第一版，以及失败时保留成果和补做缺口；是否遵循取决于模型。用户确认、授权、自动恢复和资料更新由业务程序控制，不由提示词插件实现。

在仓库根目录执行：

```bash
pnpm --filter @fly-novel/world-initialization-system-prompt typecheck
pnpm --filter @fly-novel/world-initialization-system-prompt build
```
