# src/agents/plugins/subagent 目录说明

## 仓库结构

- `subagent-fork-in-process/`：进程内 Fork Provider，继承父会话已结束轮次。
- `subagent-in-process-driver/`：`@fly-novel/subagent-in-process-driver` 独立工作区包，提供进程内子 Agent 一次性运行驱动。
- `subagent-persistent-in-process/`：`@fly-novel/subagent-persistent-in-process` 独立工作区包，提供持续身份子 Agent Provider 与可信创建绑定。
- `subagent-spawn-in-process/`：进程内 Spawn Provider 和可信创建绑定。
- `subagent/`：`@fly-novel/subagent` 独立工作区包，提供子 Agent 委派服务及 Cordis 插件。
- `tool-subagent/`：通用子 Agent 委派工具工作区包。
