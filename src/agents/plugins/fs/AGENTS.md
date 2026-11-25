# src/agents/plugins/fs 目录说明

## 仓库结构

- `fs-local/`：`@fly-novel/fs-local` 独立工作区包，提供显式装配的本机文件后端。
- `fs-observation-policy/`：文件观察策略独立工作区包，提供显式装配的事件监听插件。
- `fs-patch/`：`@fly-novel/fs-patch` 独立工作区包，提供补丁解析和文本修改。
- `fs-sandbox/`：文件修改路径边界独立工作区包。
- `fs/`：`@fly-novel/fs` 独立工作区包，定义文件系统服务契约和事件。
- `tool-fs-search/`：`@fly-novel/tool-fs-search` 独立工作区包，提供受读取范围约束的文件搜索工具。
- `tool-fs/`：文件工具和读取授权独立工作区包。
