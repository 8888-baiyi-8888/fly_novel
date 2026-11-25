# src/app/agents 目录说明

## 仓库结构

- `character-creator.ts`：角色创建 Agent 的独立应用装配与生命周期入口。
- `discussion-subagent.ts`：局部讨论专用 Agent 的只读装配与生命周期。
- `discussion-tools.ts`：绑定讨论目标的读取和候选工具。
- `history-agent.ts`：历史 Agent 的独立应用装配与生命周期入口。
- `impact-tools.ts`：绑定讨论目标的只读影响检查工具。
- `index.ts`：模块入口和导出。
- `initial-situation-agent.ts`：初始局势 Agent 的独立应用装配与生命周期入口。
- `loop-options.ts`：世界初始化 Agent 的可信步数限制校验。
- `map-agent.ts`：地图 Agent 的独立应用装配与生命周期入口。
- `organization-agent.ts`：组织 Agent 的独立应用装配与生命周期入口。
- `world-basics.ts`：世界基础信息 Agent 的独立应用装配与受控成果保存入口。
- `world-development-agent.ts`：世界发展规划 Agent 的独立应用装配与生命周期入口。
- `world-specific-agent.ts`：世界专有内容 Agent 的独立应用装配与生命周期入口。
