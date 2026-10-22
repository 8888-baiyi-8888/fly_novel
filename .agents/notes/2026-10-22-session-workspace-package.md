# Session 独立工作区包

- 问题：Session 放在 `@fly-novel/agents` 的插件目录内时，其他插件难以通过独立包入口引用其契约。
- 决定：将尚未实现的 Session 骨架移至 `src/session/`，建立私有工作区包 `@fly-novel/session`，沿用项目的 CommonJS 构建方式。
- 影响：Session 契约和插件定义后续从包入口导出；Agent 包在实际装配时再声明依赖并汇总注册。持久化仍由后续独立插件承担。
- 验证：检查工作区清单、TypeScript 路径、文档链接与包清单一致；本次未实现 Session 行为。
