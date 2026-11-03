# @fly-novel/tool-skill

`tool-skill` 插件依赖当前 Agent 的 Skill 和工具服务，注册 `skill` 工具并在模型请求前发布可调用的 Skill 摘要。插件销毁时注销工具。具体工具来自 [`@fly-novel/skill-tool-core`](../../../tools/skill/README.md)；来源、授权和目录发布行为见[工具说明](../../../tools/README.md)。

在仓库根目录执行 `pnpm --filter @fly-novel/tool-skill build` 构建。
