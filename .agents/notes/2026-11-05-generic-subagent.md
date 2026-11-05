# 通用子 Agent Preset

## 问题

通用委派工具需要一个不冒用角色、导演等业务职责的子 Agent，现有 AgentRole 仅包含业务职责。

## 决定

新增 general 职责和 generic-subagent Preset，装配通用提示词、Loop、Session 与 LLM；沿既有 Spawn 接收可信模型配置。general 只表示职责，父子关系仍由委派运行表示。

## 影响与验证

Session 持久化源码没有使用 AgentRole，本次不修改持久化格式。固定模型验证 Spawn 创建、任务原文、提示词、独立 Session、失败、取消与清理；角色参数和委派工具留待后续步骤。
