# src/agents 目录说明

## 仓库结构

- `README.md`：目录职责和使用说明。
- `character-creator/`：角色创建 Agent。
- `character/`：角色 Agent。
- `core/`：Harness 契约与注册。
- `director/`：导演 Agent。
- `generic-subagent/`：通用子 Agent 的 Preset 和职责提示词插件。
- `history-agent/`：历史专用 Agent 的 Preset 和职责提示词。
- `index.ts`：模块入口和导出。
- `initial-situation-agent/`：初始局势专用 Agent 的 Preset 和职责提示词。
- `map-agent/`：地图与空间专用 Agent 的 Preset 和职责提示词。
- `organization-agent/`：组织专用 Agent 的 Preset 和职责提示词。
- `package.json`：包定义与脚本。
- `plugins/`：所属模块的插件。
- `runtime/`：Harness 装配和生命周期。
- `tests/`：所属模块的自动化测试。
- `tsconfig.build.json`：TypeScript 编译配置。
- `tsconfig.json`：TypeScript 编译配置。
- `world-basics/`：世界基础信息 Agent 的 Harness Preset 与专有提示词插件。
- `world-development-agent/`：世界发展规划专用 Agent 的 Preset 和职责提示词。
- `world-initialization-main-agent/`：世界初始化主 Agent。
- `world-specific-agent/`：世界专有内容 Agent 的 Preset 和职责提示词。
- `writer/`：写作 Agent。
