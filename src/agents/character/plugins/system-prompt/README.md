# @fly-novel/character-system-prompt

角色 Agent 的专有 Cordis 提示词插件，依赖通用 `systemPrompt` 服务，在当前 Agent 作用域注册角色职责提示词；作用域销毁时注销。角色信息和场景由调用输入提供，插件不读取角色档案。本包提供 Harness 注册定义，角色 Preset 按插件 ID 装配。

在仓库根目录执行：

```bash
pnpm --filter @fly-novel/character-system-prompt typecheck
pnpm --filter @fly-novel/character-system-prompt build
```
