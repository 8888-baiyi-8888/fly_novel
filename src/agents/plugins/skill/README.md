# @fly-novel/skill

Skill 服务及其 Cordis 插件。`SkillService` 注册和注销提供方，合并查询摘要并按名称加载；重复提供方、同名 Skill、来源失败或查询时注册发生变化均报错，未找到返回 `undefined`。服务关闭时向进行中的查询发出取消信号并注销来源；提供方的其他资源由其所有者负责。

`skillPlugin` 为当前 Cordis 插件作用域提供 `skills` 服务，作用域销毁时关闭服务；`skillPluginDefinition` 是 Harness 注册定义。它不自动注册来源或绑定任何 Agent。文件系统来源见 [`@fly-novel/skill-filesystem`](../skill-filesystem/README.md)。

参考 [DeepSeek Harness Skill 服务](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/skill/README.md)。本包暂不实现来源优先级、部分成功结果、目录缓存或作用域继承；来源失败时整个查询报错。

在仓库根目录执行 `pnpm --filter @fly-novel/skill build` 构建。
