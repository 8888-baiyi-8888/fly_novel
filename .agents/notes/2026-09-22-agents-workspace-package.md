# Agent 工作区包

问题：Agent 依赖与构建需要独立于根应用维护。

决定：将 `src/agents/` 登记为私有包 `@fly-novel/agents`，根项目通过 `workspace:*` 引用；运行依赖迁入包清单，构建与测试显式先构建包。保持 CommonJS 输出，采用 NodeNext 解析公共导出。

影响：包入口不执行示例，原示例保留在包 README。此次只建立包边界，不实现四类模板。设计归属见 [Agent 包决策](../../docs/decisions/2026-09-22-agents-workspace-package.md)。

验证：离线安装、`pnpm run typecheck`、`pnpm run build`、`pnpm test` 通过，现有 7 项测试通过；CommonJS 与 ESM 包名加载、声明产物、文档链接及空白检查通过。
