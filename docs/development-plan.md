# 长期开发计划

本计划记录已确定的开发顺序。后续阶段在开始开发时再确定详细范围与验收标准。

1. 开发 Agent Harness。
2. 更新现有的小说级工作流。
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
3. **系统提示词插件（`src/agents/plugins/`）**：先学习并实现可独立使用的通用提示词对象，再逐步支持多段组装，最后通过现有注册方式提供给 Harness Agent；本项开发顺序见下文。
4. **真实 Agent Loop 插件（`src/agents/plugins/loop/`）**：替换回显输入的 mock loop，先完成无需工具的一轮调用：读取 Session、组装提示词、调用 LLM、记录结果并返回。该步骤完成后，至少一个 Harness Agent 能通过现有 Preset 运行真实模型。
5. **工具插件（`src/agents/plugins/`）**：建立工具注册、可见范围和执行结果返回机制，再接入一个小说资料只读工具；扩展 Loop 处理模型发起的工具调用。工具提供的数据遵守调用方确定的角色可见范围。
6. **角色专有插件与组合**：逐个开发角色、导演等所需的提示词、资料查询和其他专有能力，在各自现有 Preset 中按插件 ID 选择；Session、LLM、Loop 和工具基础插件按需复用。
7. **按需求扩展会话能力**：需要进程重启后继续使用会话时，另建 Session 持久化插件，将第 1 步的会话数据保存到存储介质，并在启动时读取和恢复；对照官方 [`@deepseek-ai/dsh-session-persistence`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence/README.md) 定义持久化服务契约，以及 [`@deepseek-ai/dsh-session-persistence-jsonl`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/README.md) 的具体存储实现。并发写入、异常恢复等生命周期问题在出现实际需求时一并处理；长历史检索和上下文压缩也分别按需设计为独立插件。对话历史归 Session；角色经历与认知属于小说领域数据，不直接以实例内的 mock memory 代替。

#### Session 插件开发

按下面的顺序学习官方 Session 的职责，并在本项目的 Session 插件中逐步实现；第 1 至 4 步属于上方 Harness 开发顺序的第 1 项，第 5 至 6 步留到第 7 项按需求开展。

1. **Session 基础类**：建立内存会话，支持创建会话、追加事件和按顺序读取历史。先明确一份 Session 保存什么，以及 Agent 如何取得它。
2. **消息与事件类型**：明确“会话事件”和“模型消息”的区别，区分发送者、消息内容与运行事件，逐步加入轮次、助手回复、工具调用及结果记录；明确哪些事件属于 Session 历史，以及如何从事件得到消息视图。模型消息复用项目已有的 [`@fly-novel/llm` 消息类型](../src/llm/message.ts)，对照学习官方的 `SessionEvent` 类型体系。
3. **Session Manager**：统一创建、获取、列出和关闭多个 Session，确定 Session ID、Agent ID 及实例生命周期的关系。对应学习官方的 ctx.sessions 管理服务。
4. **模型上下文导出**：从会话记录生成下一次模型请求需要的消息历史，支持同一 Agent 连续多轮运行。角色能读取哪些小说资料由角色插件或调用方控制；通用 Session 负责整理该会话的历史。对应学习官方的 deriveMessages()。此步只派生输入，不引入历史检索或压缩。
5. **Session 持久化（上方开发顺序第 7 项）**：出现跨进程恢复需求时，通过独立持久化插件保存和读取 Session，并设计存储格式、版本及恢复方式；不把文件读写放进基础 Session 插件。
6. **生命周期完善（上方开发顺序第 7 项）**：在实际出现并发写入、异常恢复等需求时，补全对应的顺序约束、失败处理和资源清理；基础的关闭与资源释放在第 3 步完成。

#### 系统提示词插件

**目标**：参考 DeepSeek Harness 官方 [`@deepseek-ai/dsh-system-prompt`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/README.zh.md)，逐步实现通用 SystemPrompt 插件。

以官方架构为最终参考，但不一次性实现所有功能。先建立最小可运行闭环，再沿主线逐步增强，每一步对照官方对应设计。

当前仅开发 `src/agents/plugins/system-prompt/`，不涉及角色、导演等业务插件及真实 Loop 接入。

**开发主线：**

1. **基础对象**：了解官方 SystemPrompt 的整体职责和使用方式，建立最小服务对象，能够保存并读取提示词。
2. **Section 注册**：参考官方 `PromptSection` 和 `section()`，支持多个提示词段的注册、管理及注销。
3. **组装与渲染**：实现 `assemble()` 和 `renderPrompt()`，完成从多个 Section 到最终系统提示词的核心闭环。
4. **动态能力**：逐步增加动态文本、变量管理与插值，理解组装时求值和渲染时处理的区别。
5. **作用域与覆盖**：参考官方设计，逐步加入作用域隔离、全局段遮蔽及 `complete` 替换能力。
6. **Cordis 接入**：将 SystemPrompt 接入现有插件注册表，通过 Preset 装配，验证不同 Agent 的服务隔离及插件生命周期。
7. **SystemPrompt 独立包**：将 `src/agents/plugins/system-prompt/` 建立为 `@fly-novel/system-prompt` 工作区包，形成独立的包清单、编译配置和公共导出入口，使提示词对象可脱离 `@fly-novel/agents` 单独构建和使用。整理 SystemPrompt 核心能力与 Harness 插件注册适配层的依赖边界，避免 SystemPrompt 核心反向依赖 Agent 包；同步 workspace、包依赖、导入路径及构建配置。Cordis 插件可由该包提供，但 Harness 注册表和 Preset 仍由 `@fly-novel/agents` 管理。验收独立包构建、公共入口导入、Agents 集成构建及现有行为测试。
8. **其他官方能力（其他插件开发后，再进行）**：了解动态 Runtime Context、工具 Schema 贡献与排序、Assemble Waterfall 等机制。属于当前通用模块的能力按需实现，依赖其他子系统的部分留到后续集成阶段。

**开发要求：**

- 每次只推进一步，先了解官方对应设计及使用方式，再讨论并实现。
- 每一步完成后进行实际调用验证，并简要对照官方实现。
- 不提前开发后续功能，但需说明后续可扩展的能力。
- 不要求逐行复刻源码，但核心接口和架构尽量与官方保持一致，不能擅自重新设计简化替代品。
- 每一步完成后停止，等待下一步指示。

最终实现一个符合 DSH 设计思路、可独立使用并能接入现有 Harness 的 SystemPrompt 插件。

### 本阶段完成标准

- 至少一个 Agent 通过现有 Preset 完成真实模型调用，Session 可提供该调用所需的历史并记录结果。
- 不同 Agent 的专有插件由各自 Preset 选择，插件服务和运行状态按实例隔离；销毁 Agent 时释放其插件资源。
- Loop 能完成一次受控的工具调用，并将工具结果纳入后续模型输入；模型、工具和插件失败有明确的传播方式。
- Harness 的可运行入口、插件归属和新增插件的装配方式记录在 [Agent 包说明](../src/agents/README.md)；相关行为由聚焦检查验证。

## 后续阶段

小说级工作流、故事级工作流、小说撰写功能和前端页面的实施计划，在进入对应阶段时分别编写。
