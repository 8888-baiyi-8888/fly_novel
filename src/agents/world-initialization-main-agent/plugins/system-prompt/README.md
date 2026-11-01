# @fly-novel/world-initialization-system-prompt

世界初始化主 Agent 的专有 Cordis 提示词插件。插件依赖 `systemPrompt` 服务，在当前 Agent 作用域注册职责提示词；插件作用域销毁时注销该提示词。通用提示词的注册、组装和渲染由 [`@fly-novel/system-prompt`](../../../plugins/system-prompt/README.md) 提供。

插件定义由 Agents 包注册；主 Agent 的 Preset 和创建入口尚未建立。用户确认、超时和资料更新由业务程序控制，不由提示词插件实现。

在仓库根目录执行：

```bash
pnpm --filter @fly-novel/world-initialization-system-prompt typecheck
pnpm --filter @fly-novel/world-initialization-system-prompt build
```
