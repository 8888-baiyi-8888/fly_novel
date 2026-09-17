# Agent 运行框架

本目录是私有工作区包 `@fly-novel/harness`，由自己的 `package.json` 管理依赖。公共入口为 `index.ts`，构建产物输出到本包 `dist/`，测试放在本包 `tests/`。构建命令为 `pnpm --filter @fly-novel/harness run build`，根目录构建也会按依赖顺序构建本包。

添加外部依赖时，在项目根目录执行 `pnpm --filter @fly-novel/harness add 包名`；命令更新本包的依赖清单及根目录共享锁文件。LLM 与共享工具使用 `workspace:*` 引用。

## 一级子目录

学习阶段的 DSH 依赖通过 `link:` 引用同级 `deepseek-harness` 仓库中的已构建包；外部引用集中在 `session/dependencies.ts`。投影、会话和 Agent 包使用其自身工作区的传递依赖，Zod 链接到投影包已安装的同一份依赖。该配置依赖本机目录布局：两个仓库应位于同一父目录，DSH 仓库需已安装依赖并生成 `lib/` 产物。移动仓库或清理 DSH 依赖后需重新准备依赖与构建，再在本项目运行 `pnpm install`。本地包不会随本项目自动构建，源码变更后需在 DSH 仓库按其构建说明更新产物。

| 子目录 | 作用 |
| --- | --- |
| [agent/](agent/README.md) | Agent 接口、注册、创建、查询和生命周期管理。 |
| [agent-loop/](agent-loop/README.md) | 驱动 Agent 调用大语言模型和工具，直至本轮结束。 |
| [tools/](tools/README.md) | 工具定义、注册、输入校验和执行。 |
| [session/](session/README.md) | 会话状态和追加式事件日志。 |
| [session-persistence/](session-persistence/README.md) | 会话与事件日志的持久化接口。 |
| [session-persistence-jsonl/](session-persistence-jsonl/README.md) | 使用本地 JSONL 文件实现会话持久化。 |
| [system-prompt/](system-prompt/README.md) | 系统提示词片段的注册与组装。 |
| [subagent/](subagent/README.md) | 子 Agent 的创建、委派、状态查询和回收。 |
| [user-approval/](user-approval/README.md) | 人工确认请求及批准、拒绝结果的处理。 |
