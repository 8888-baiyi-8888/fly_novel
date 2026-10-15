# 章节流接入角色 Agent

## 决定

章节 `simulate` 逐个调用 `CharacterAgentManager`，用 `BookRuntime` 中的角色 ID、角色卡和当前角色状态提供角色专属输入。角色卡经 `characterInfos` 传给 Agent，避免依赖与小说工作区不一致的旧 `novel_data` 档案路径。S 级复用默认持久 thread，A 级使用章节专属 thread，B 级不创建角色 Agent。其余章节节点继续通过 `AgentPort` 使用现有通用模型调用。

## 生命周期

章节应用在连续章节之间复用同一个 manager，以维持 S 级会话和限制角色 Agent 数量；单次 CLI 运行结束后清空 manager。角色 Agent 共用章节应用配置的模型实例，运行分支固定为 `main`。

## 验证

运行根项目 TypeScript 正式构建，确认 agents 包导出、章节节点类型与应用装配一致。真实模型调用不纳入构建验证。
