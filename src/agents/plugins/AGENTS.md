# src/agents/plugins 目录说明

## 仓库结构

- `character/`：`@fly-novel/character` 独立工作区包，提供人物及关系格式、受控存储、查询和工具。
- `fs/`：文件系统能力工作区包目录，包含基础库、服务、后端与工具插件。
- `history/`：`@fly-novel/history` 独立工作区包，提供历史事件格式、受控存储、查询及工具。
- `index.ts`：模块入口和导出。
- `initial-situation/`：`@fly-novel/initial-situation` 独立工作区包，提供初始局势 JSON 格式、受控存储和工具。
- `llm/`：LLM 服务插件，按 Agent 实例注册适配器路由并随插件作用域清理。
- `loop/`：`@fly-novel/agent-loop` 独立工作区包，提供 AgentLoop 契约、Runtime 与 Cordis 插件。
- `map/`：`@fly-novel/map` 独立工作区包，提供地图 JSON 格式、受控文档存储、查询及工具定义。
- `memory/`：记忆相关插件源码。
- `organization/`：`@fly-novel/organization` 独立工作区包，提供组织与关系 JSON 格式和受控文档存储。
- `sandbox/`：沙箱模式和文件修改策略。
- `session-persistence-jsonl/`：Session JSONL 文件持久化后端。
- `session-persistence/`：`@fly-novel/session-persistence` 独立工作区包，提供 Session 持久化服务与句柄契约；具体存储由后端提供。
- `session/`：`@fly-novel/session` 会话事件和管理包。
- `skill-filesystem/`：`@fly-novel/skill-filesystem` 独立工作区包，提供文件系统 Skill 来源及插件。
- `skill/`：`@fly-novel/skill` 独立工作区包，提供 Skill 来源注册、查询与 Cordis 服务插件。
- `subagent/`：SubAgent 核心服务、进程内运行驱动和 Spawn Provider 工作区包。
- `subprocess/`：受管理子进程及超时工具。
- `system-prompt/`：`@fly-novel/system-prompt` 独立工作区包，提供通用提示词核心、Cordis 服务插件及注册定义。
- `tool-skill/`：`@fly-novel/tool-skill` 独立工作区包，装配 Skill 工具和模型目录。
- `tools/`：`@fly-novel/tools` 独立工作区包，提供工具定义、注册与执行服务。
- `world-development/`：`@fly-novel/world-development` 独立工作区包，提供世界发展规划 JSON 格式、受控存储、查询与工具。
- `world-specific/`：`@fly-novel/world-specific` 独立工作区包，提供世界专有内容 JSON 格式、受控存储、查询和工具。
