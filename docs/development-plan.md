# 长期开发计划

本计划记录已确定的开发顺序；各模块的详细开发计划见对应子文件。其他阶段在开始开发时再确定详细范围与验收标准。

1. 开发 Agent Harness。
2. 更新现有的小说级工作流，并将其改名为世界初始化工作流。
3. 更新现有的章节级工作流，并将其改名为故事级工作流。
4. 完成小说撰写功能。
5. 完成前端页面撰写。

## 学习型开发要求

本项目以学习和理解 DeepSeek Harness 的设计思想为主要目标，不以尽快复刻官方代码为目标。

开发每个模块时，严格按照既定阶段逐步推进。

1. 每个阶段开始前，先说明当前功能需要解决的问题，展示实际使用方式，明确输入、输出及预期行为。
2. 在使用方式与接口确定后，再进行最小功能实现。
3. 不提前开发后续阶段的功能，不为了未来可能出现的需求引入额外抽象。
4. 当前阶段完成后，通过实际使用示例和必要测试进行验证。
5. 验证完成后，对照 DeepSeek Harness 官方对应实现，解释双方设计上的异同及其原因。
6. 未得到明确指示，不得自动进入下一阶段。

整个开发过程优先保证我能够理解每一部分的职责、设计原因、使用方式以及它在 Harness 中所处的位置，而不是一次性生成完整实现。

## 第一阶段：开发 Agent Harness

### 目标与起点

建立能够按 Preset 为不同 Agent 装配插件、运行真实模型调用并管理实例生命周期的 Harness。现有的插件注册表、Preset、Factory、Manager 和 mock 插件见 [Agent 包说明](../src/agents/README.md#cordis-harness)；本阶段沿用这些装配入口，在现有 Preset 中选择新增插件，不另建 Preset 体系。共享 Harness 插件放在 `src/agents/plugins/` 下，角色专有插件放在对应角色目录；能力职责参考 [DeepSeek Harness 的包分组](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/README.zh.md)，目录名称以本项目为准。

### 开发顺序

1. **Session 插件（`src/agents/plugins/session/`，包名 `@fly-novel/session`）**：对照官方 [`@deepseek-ai/dsh-session`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/README.md)，建立内存中的会话、消息与事件记录、读取及历史派生能力，使后续模型请求能够从同一份 Session 历史组装输入。这一步只管理进程内的 Session，不负责写入存储介质或在进程重启后恢复会话。
2. **LLM 服务接入**：复用现有的 [LLM 模块](../src/llm/README.md)，仅在 src/agents/plugins/llm/ 实现 Cordis 装配插件，不复制 LLM 调用逻辑。插件定义加入现有注册表；需要 LLM 的 Agent 在各自的 Preset 中按插件 ID 选择，由现有 Agent 创建配置向该实例传入适配器。应用入口负责读取模型配置和凭据、创建适配器；插件在该 Agent 的作用域内注册模型路由，并随 Agent 销毁注销。后续真实 Loop 使用本实例的 LLM 服务，取消与错误结果遵循现有 LLM 契约。LLM 不在 Harness 根 Context 注册，不增加公共插件绑定、专用启动入口或专用清理入口。
3. **系统提示词插件（`src/agents/plugins/`）**：先学习并实现可独立使用的通用提示词对象，再逐步支持多段组装，最后通过现有注册方式提供给 Harness Agent；详细开发顺序见[系统提示词插件开发计划](modules/agents/system-prompt-development-plan.md)。
4. **真实 Agent Loop 插件（`src/agents/plugins/loop/`）**：替换回显输入的 mock loop，先完成无需工具的一轮调用：读取 Session、组装提示词、调用 LLM、记录结果并返回。该步骤完成后，至少一个 Harness Agent 能通过现有 Preset 运行真实模型。
5. **工具插件（`src/agents/plugins/tools/`）**：按[工具插件开发计划](modules/agents/tool-plugin-development-plan.md)，学习 DeepSeek Harness 的工具定义、注册、执行和 Loop 调用方案；先建立最小可用注册与执行闭环，再通过只读小说资料工具验证。工具提供的数据遵守调用方确定的角色可见范围。
6. **角色专有插件与组合**：逐个开发角色、导演等所需的提示词、资料查询和其他专有能力，在各自现有 Preset 中按插件 ID 选择；Session、LLM、Loop 和工具基础插件按需复用。详细顺序见[角色专有插件与组合开发计划](modules/agents/role-specific-plugin-development-plan.md)。
7. **按需求扩展会话能力**：需要进程重启后继续使用会话时，另建 Session 持久化插件，将第 1 步的会话数据保存到存储介质，并在启动时读取和恢复；对照官方 [`@deepseek-ai/dsh-session-persistence`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence/README.md) 定义持久化服务契约，以及 [`@deepseek-ai/dsh-session-persistence-jsonl`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/README.md) 的具体存储实现。并发写入、异常恢复等生命周期问题在出现实际需求时一并处理；长历史检索和上下文压缩也分别按需设计为独立插件。对话历史归 Session；角色经历与认知属于小说领域数据，不直接以实例内的 mock memory 代替。详细顺序见[Session 扩展能力开发计划](modules/agents/session-extension-development-plan.md)。

### 本阶段完成标准

- 至少一个 Agent 通过现有 Preset 完成真实模型调用，Session 可提供该调用所需的历史并记录结果。
- 不同 Agent 的专有插件由各自 Preset 选择，插件服务和运行状态按实例隔离；销毁 Agent 时释放其插件资源。
- Loop 能完成一次受控的工具调用，并将工具结果纳入后续模型输入；模型、工具和插件失败有明确的传播方式。
- Harness 的可运行入口、插件归属和新增插件的装配方式记录在 [Agent 包说明](../src/agents/README.md)；相关行为由聚焦检查验证。

## 后续阶段

世界初始化工作流的已确认方向和后续设计顺序见[世界初始化工作流开发计划](workflows/word-initialization/world-initialization-development-plan.md)。故事级工作流、小说撰写功能和前端页面的实施计划，在进入对应阶段时分别编写。
