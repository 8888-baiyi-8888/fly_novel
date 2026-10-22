# Session 独立工作区包

- 问题：其他插件需要通过包名引用 Session 契约，同时 Session 源码应留在原有插件目录。
- 决定：在 `src/agents/plugins/session/` 建立私有工作区包 `@fly-novel/session`，沿用项目的 CommonJS 构建方式，并从父级 Agent 包的编译输入中排除该子包。
- 影响：Session 契约和插件定义后续从包入口导出；Agent 包在实际装配时再声明依赖并汇总注册。持久化仍由后续独立插件承担，测试放在 `src/agents/tests/`。
- 验证：检查工作区清单、TypeScript 路径、文档链接与包清单一致；本次未实现 Session 行为。
