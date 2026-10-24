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

**当前范围**：只在 `src/agents/plugins/system-prompt/` 学习和开发通用 SystemPrompt 能力，并接入现有插件注册表。示例使用“你是写作助手”“回答应简洁”等通用文本。角色、导演等专用提示词贡献插件，以及真实 Loop、LLM、Session 的接入，都不属于本节；进入后续开发顺序时再单独规划。这里的调用方式是待讨论的使用示意，不表示接口已经确定或代码已经存在。

每一步按上方“学习型开发要求”推进：先解释问题、展示最简单的使用方式与预期结果，确定接口后才实现；实际调用并验证后，再对照官方 [`@deepseek-ai/dsh-system-prompt`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/README.zh.md) 解释相同点、差异和原因。每完成一步即停下，等待明确指示。

1. **先弄懂 SystemPrompt 用来做什么**：从“给出一段系统提示词，取得可供模型使用的文本”开始，说明输入、输出和使用者，以及它与消息历史的职责边界。先写出期望的最小使用示意，例如创建对象、放入“你是写作助手”、读出相同文本；此步只讨论用法，不写插件代码，也不预定 Section 字段或 Cordis 接口。完成时应能用自己的话解释为什么需要这个对象。
2. **建立最小的提示词对象**：根据第 1 步确定的用法，在通用插件目录中实现保存和读取一份固定文本的对象。用两个独立实例分别保存不同文本，观察它们互不影响，并确认空对象如何返回。此步要弄清对象持有什么状态；不加入多段、排序和插件注册。
3. **从一份文本走到多个 Section**：用“基础身份”和“行为约束”两段通用文本说明一份字符串为何不便于单独修改或移除。先讨论如何标识、登记、读取和移除一段，再根据该用法调整第 2 步的对象。实际展示修改一段而另一段不受影响；此时只解决多来源内容的管理，不提前决定排序、动态求值等规则。
4. **把多个 Section 组装成最终文本**：先比较两种登记顺序，观察输出是否应相同，再确定顺序与拼接规则。根据使用需要实现组装和渲染，并展示最终文本；此时再讨论是否需要把中间的组装结果与最终字符串分开。用实际调用验证登记顺序、空内容和冲突输入，解释组装失败时应怎样避免输出部分提示词。随后对照官方 `section()`、`assemble()`、`renderPrompt()` 的分工；动态文本、变量及其他高级能力留待出现实际场景时学习。
5. **把通用对象接入 Harness 插件体系**：前四步的对象可以独立使用，此时才学习为什么 Agent 需要通过 Cordis 获取服务。对照现有[内置插件注册方式](../src/agents/README.md#cordis-harness)，把通用对象作为插件服务加入注册表，通过测试用 Preset 选择；使用现有 mock loop 满足 Agent 创建要求，但不改变模型调用。展示创建两个 Agent、分别登记通用 Section、读取各自结果，以及销毁后释放注册资源。再对照官方 `ctx.systemPrompt` 的使用方式，解释本项目的服务归属与清理方式。

完成第 5 步时，只验收通用插件能独立管理、组装提示词，并被不同 Harness Agent 隔离使用；不以任何专用 Agent 的提示词或真实模型请求作为本节完成条件。

### 本阶段完成标准

- 至少一个 Agent 通过现有 Preset 完成真实模型调用，Session 可提供该调用所需的历史并记录结果。
- 不同 Agent 的专有插件由各自 Preset 选择，插件服务和运行状态按实例隔离；销毁 Agent 时释放其插件资源。
- Loop 能完成一次受控的工具调用，并将工具结果纳入后续模型输入；模型、工具和插件失败有明确的传播方式。
- Harness 的可运行入口、插件归属和新增插件的装配方式记录在 [Agent 包说明](../src/agents/README.md)；相关行为由聚焦检查验证。

## 后续阶段

小说级工作流、故事级工作流、小说撰写功能和前端页面的实施计划，在进入对应阶段时分别编写。
