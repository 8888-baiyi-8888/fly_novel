# Skill 工具与插件的归属

## 问题

Skill 工具定义与 Agent 插件原先同处工具包，插件 ID 与官方 tool-skill 名称不一致。

## 决定

工具定义由 src/tools/skill 的 skill-tool-core 包提供；tool-skill 插件及注册定义放在 src/agents/plugins/tool-skill，依赖工具定义并负责注册、目录发布和清理。Preset 使用 tool-skill ID，模型工具名称仍为 skill。

## 影响与验证

工作区包依赖、构建入口和 Preset 同步更新。聚焦测试覆盖主 Agent 创建、工具调用、目录展示、来源隔离及销毁；正式构建检查包入口和旧产物清理。
