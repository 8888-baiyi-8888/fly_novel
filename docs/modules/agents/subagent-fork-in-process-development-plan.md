# Fork In Process 详细开发计划

本文细化[第三阶段的 Fork In Process](../../workflows/word-initialization/world-initialization-stage-3-plan.md#5-fork-in-process)，按学习、设计、实现和验证的顺序建立进程内的一次性 Fork 委派。本文是开发计划，示意名称不是已实现接口。每一步先说明问题、使用方式、输入、输出与预期行为，完成后记录实际结果并等待用户指示；完成本计划后不自动进入其他阶段。

## 一、目标与使用场景

Spawn 适合任务说明本身包含所需上下文的子任务；Fork 面向需要参考父 Agent 过往对话的子任务。目标是创建独立子 Agent，将父会话选定的已完成历史作为子会话的初始内容，执行新任务并返回子任务结果。父子各自持有独立 Session，Fork 是启动时的一次性历史快照，不是对父会话的持续订阅，也不把子任务中间记录自动写回父会话。

可信调用方预期通过父 Agent 作用域的 SubAgent 服务选择 Fork，提供任务、取消信号以及经确认所需的类型选择和创建参数。服务返回运行句柄，调用方等待结果并负责释放。具体请求形状、默认值和参数是否允许，要在第 2 步核实并确定；本计划的示意不构成可运行 API。

| 关注点 | Spawn 当前行为 | Fork 目标与待确定事项 |
|---|---|---|
| 会话起点 | 新建独立会话，不继承父历史。 | 将父会话一次性快照导入独立子会话；历史边界和合法性在第 2、3 步确定。 |
| 子 Agent 类型 | `presetId` 由可信创建方按注册表和允许配置校验。 | 类型选择与创建参数独立于 Fork 方式；允许哪些 Preset、如何验证历史与所选类型兼容，先设计再实现。 |
| 工具与配置 | 子 Agent 按自己的 Preset 和可信配置装配。 | 不把父工具注册、权限或插件实例当作历史复制；历史中的工具调用、结果与目标模型和工具配置的兼容性须单独核实。 |
| 运行与结果 | 复用 Driver，返回句柄、结果与释放操作。 | 优先复用同一 Driver，确认结果只代表子任务的输出，不能将继承历史中的父回复当作子结果。 |

例如，父 Agent 的第一轮已讨论世界背景，第二轮正在请求委派：若采用官方的已完成轮次边界，子 Agent 可以继承第一轮，但看不到第二轮当前输入或工具调用。新任务若依赖第二轮信息，仍需要明确携带；该边界是否完全适配本项目，在第 2 步结合源码和测试确定。

## 二、固定参考与项目现状

官方参考固定为 DeepSeek Harness commit [`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`](https://github.com/deepseek-ai/deepseek-harness/tree/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent-fork-in-process)。该版本的 [Fork 源码](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent-fork-in-process/src/index.ts)读取父 Session，截取最后一个 `turn/end` 之前及其自身的事件前缀；没有已完成轮次时不传 seed，并交给共享 Driver。当前轮次不进入该前缀。[官方包说明](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent-fork-in-process/README.zh.md)说明历史只在创建时捕获，子 Agent 具有独立工具作用域。官方还支持可继续运行及其他能力，不能由此推断本项目已经支持它们，也不假定该版本官方支持任意切换项目 Preset。

本项目已有 [SubAgent 服务](../../../src/agents/plugins/subagent/subagent/README.md)、[共享 Driver](../../../src/agents/plugins/subagent/subagent-in-process-driver/README.md)、[Spawn Provider](../../../src/agents/plugins/subagent/subagent-spawn-in-process/README.md)和[可信 Spawn 创建方](../../../src/agents/runtime/subagent-in-process-creator.ts)。服务请求中的父对象目前只要求身份视图；仅凭这个身份无法直接取得可信父 Session。Driver 接收创建函数并负责运行和释放，不提供历史读取或导入。Spawn 创建方拒绝通过 Loop 配置指定持久化 Session ID，并不负责 Fork。

[Session](../../../src/agents/plugins/session/session.ts) 和 [Session Manager](../../../src/agents/plugins/session/session-manager.ts)提供 seed 相关能力；[Agent Loop](../../../src/agents/plugins/loop/agent-loop-runtime.ts)内部的持久化恢复路径使用 seed，但公开的 Agent 创建和普通 Loop 配置尚没有可直接用于 Fork 的历史注入契约。需要核实事件验证、序号、轮次、消息投影、系统提示词与持久化，不把内部 seed 等同于可用的 Fork 功能。

当前[通用委派工具](../../../src/agents/plugins/subagent/tool-subagent/index.ts)和[角色委派工具](../../../src/tools/character/delegate-character.ts)都固定选择 `spawn`；角色工具传递 `characterId`，角色 Agent 尚未按 ID 检索资料。新增 Fork Provider 本身不会让这两个工具自动改用 Fork，也不能把 Provider 注册当成模型已经可以选择 Fork。

## 三、设计边界

- **历史快照：** 建议以已完成轮次作为首选参考，明确读取时机、原子性、空历史和进行中轮次；快照创建后父子变更互不传播。是否允许指定更早边界或过滤内容由第 2 步按实际需求决定，不预建额外参数。
- **父身份和授权：** 由可信装配获得父 Agent 与其活动 Session，核实服务作用域和实际实例的关系；不能仅凭请求自报的父 ID 查找或授权任意会话。无会话、多个会话、已销毁或无法确认归属时的行为须明确。
- **类型与业务参数：** 创建方式与 Preset 是两个维度。评估通用和角色 Preset，沿用既有可信允许范围、模型配置与每次创建参数；`characterId` 只说明身份参数传递，不代表资料已加载。历史不兼容、未注册或不允许的类型必须明确失败，不静默切换或丢弃历史。
- **历史兼容：** 历史包含系统消息、用户和助手消息、工具调用及结果，也可能含供应商回放状态。检查目标 Preset 的系统提示词、模型路由、工具 Schema 和历史重放是否相容；先确定支持范围与拒绝策略，不假定换 Preset 或跨模型总是安全。不能简单过滤工具事件而破坏调用与结果配对。
- **敏感上下文：** Fork 可能把父历史中的工具结果和业务内容传给子 Agent 或其模型供应商；可信调用方应明确允许共享的历史和模型路由，失败时不在错误或日志中输出完整历史、凭据或配置。工具权限由子实例自身装配，历史不授予权限。
- **持久化：** 首版先评估独立内存 Session；如允许持久化，先确定新 Session 的存储归属、seed 与后续事件的原子写入、版本和失败回滚。不得复用父持久化 ID、改写父数据或静默误读旧格式；无法确保时明确拒绝对应配置。
- **生命周期：** 未交付前的创建与历史注入失败由创建方回滚；已交付后由 Run 持有者释放。取消、关闭、重复释放、失败与清理失败遵循现有服务和 Driver 契约，并验证无子实例、会话或持久化句柄泄漏。

## 四、详细开发步骤

### 1. 追踪官方调用链与本项目 Session

**问题与使用方式：** 先确认 Fork 如何截取历史、创建子 Agent 和取得结果，以及项目从父 Agent 到 Session、从 seed 到模型消息的实际路径。本步只读源码和测试，必要时用不修改数据的聚焦验证。

1. 核对上述固定 commit，阅读官方 Fork、Spawn、共享 Driver、Session seed 与相关测试；记录完成轮次边界、空历史、快照时机、结果读取和释放。区分一次性与可继续路径，不将官方能力直接映射为项目已有能力。
2. 追踪本项目 `Agent.run()`、Loop 的活动 Session、`Session.read()`、seed 校验、消息投影及恢复测试；记录 `turn/end`、事件序号、系统消息、工具调用配对与 `replayState` 的实际处理。
3. 核查父身份视图、服务作用域、Session 访问入口、Manager 创建和释放、可信 Preset 配置、角色参数，以及现有两个工具固定选择 Spawn 的事实。
4. 记录可复用组件、缺失的可信父 Session 与注入路径、未知的兼容性问题；使用最小示例解释上一轮和当前轮分别能否继承。

**完成条件：** 文档给出官方与项目的实际调用链、数据边界和缺口，指出尚需设计的事项；不实现 Provider 或修改会话数据。

#### 第 1 步：官方调用链与观察

固定参考 commit 已在本地官方仓库核对为 `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`。以下是对该版本源码和测试的阅读结论，不是本项目已实现的 Fork 行为。

1. 官方一次性 Fork 的调用链是 `subagents.start('fork', request)` → Fork Provider 读取 `request.parent.session` 的事件快照 → 查找最后一个 `turn/end` 并截取包含该事件的前缀 → 把非空 seed 交给 [共享 Driver](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent-in-process-driver/src/index.ts) → Driver 调用父上下文的 Agent 创建服务，建立带独立 Session ID 的子实例并提交新任务 → 返回 Run → 调用方等待 `result` 并调用 `dispose()`。没有已结束轮次时，Fork 不传 seed；[官方 Spawn](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent-spawn-in-process/src/index.ts)始终不传 seed。
2. 官方 Fork 查找的是最后一个 `turn/end`，代码不按结束原因筛选；当前未结束轮次整体排除。官方实现依赖其事件 `seq` 与数组下标一致。前缀在启动时获取一次，父会话之后新增的事件不属于这次子会话初始内容。[官方 Fork 测试](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent-fork-in-process/tests/subagent-fork-in-process.spec.ts)覆盖空历史、多个已结束轮次、进行中的轮次及子任务空输出。
3. 官方 Driver 在创建子 Agent 时记录 seed 长度作为读取边界；它从该边界之后的子会话事件提取结果，避免子 Agent 未产生回复时误返回父历史中的助手回复。取消信号交给子 Agent，`dispose()` 等待子实例销毁和结果结算。官方 Provider 另有 `prepareContinuable` 提供创建时快照；可继续运行由另一条管理路径处理，并不经过此一次性 Driver。
4. 不要将官方 Provider 与官方的通用 [SessionStore.fork 测试](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/core/session/tests/fork.spec.ts)混为同一入口：后者还有显式边界及已结束轮次后稳定日志事件的测试；本步对一次性委派边界的结论来自 Fork Provider 本身。

例如父会话第一轮是“世界有浮空岛”，第二轮用户要求“分析这座岛”，父 Agent 正在第二轮调用 Fork 工具：官方 Fork 的初始历史只包括第一轮，不包括第二轮用户输入或当前工具调用。如果子任务需要“这座岛”所指的具体信息，当前任务说明仍须携带它；第一轮尚未结束时，初始历史为空。

#### 本项目：从 Agent 到 Session 和模型请求

1. [AgentInstance.run](../../../src/agents/core/agent.ts)将输入交给本实例 Context 中的 Agent Loop。标准 [AgentLoopRuntime](../../../src/agents/plugins/loop/agent-loop-runtime.ts)持有一个私有 `session`：普通初始化时通过当前 Agent 的 `ctx.sessions.create()` 新建；它把请求排队执行，为每轮追加 `turn/start`，结束时追加 `turn/end`，成功、取消、错误和达到 Step 上限均有不同结束原因。Session Manager 可以管理多个 Session，`list()` 返回实例列表；仅凭列表顺序不能作为通用的活动 Loop Session 契约。
2. [Session.append / read](../../../src/agents/plugins/session/session.ts)以当前事件数量生成从零开始的连续 `seq`，写入时深复制并冻结事件；`read()` 返回新的数组，但数组中的事件是冻结的既有快照。`Session` 初始化 seed 时检查从零连续的序号，深复制并冻结，再调用 `deriveMessages()`。这证明了序号和消息配对检查的具体行为，不能据此声称 seed 已完整验证所有轮次不变量。
3. `deriveMessages()` 从事件构造模型消息：只保留最新系统消息并放在最前，其余用户、助手及工具结果消息按顺序保留；工具执行记录等非消息事件不直接进入模型消息。它拒绝缺少结果、错配或重复的工具调用结果。Loop 每个 Step 重新组装自身系统提示并追加系统消息，再把 `deriveMessages()` 的结果送入模型。因此种入父历史后子提示词如何影响最终模型上下文，需要结合实际初始化和运行验证，不能简单认为父系统消息永远生效。
4. Loop 将模型完成块中的 `replayState` 写入助手消息来源；[LLM Runtime](../../../src/llm/runtime.ts)向适配器分发前，若历史消息来源 Provider 对应的适配器实例与当前适配器不同，会移除该消息的私有 `replayState`。这是现有路由处理，不代表不同供应商、模型或工具历史在 Fork 中已经过兼容性验证。
5. 持久化恢复路径读取同一 Session 的存储事件，对中断轮次补充必要的收尾记录后，以 seed 建立 Session，并由 Loop 根据 `turn/start` 的最大轮次继续编号；这不同于从父会话复制历史创建另一个独立子会话。[恢复测试](../../../src/agents/tests/agent-loop-persistence.test.ts)和[中断恢复测试](../../../src/agents/tests/agent-loop-interrupted.test.ts)覆盖这条恢复路径，不能把它当作 Fork 已可用的证据。

#### 本项目：委派调用链与缺口

当前通用工具与角色工具分别构造 `generic-subagent` 和 `character-agent` 的 Spawn 请求，传入的 `parent` 都是只包含 ID 的身份视图；角色工具额外携带 `parameters.characterId`。`SubagentRuntime.start()` 路由至已注册 Provider；Spawn Provider 调用共享 Driver 和可信创建函数；创建函数用 Preset 注册表及显式配置创建独立 Agent，发布后的 Run 由工具等待并释放。参见[核心请求契约](../../../src/agents/plugins/subagent/subagent/types.ts)、[Spawn 创建方](../../../src/agents/runtime/subagent-in-process-creator.ts)和[进程内 Driver](../../../src/agents/plugins/subagent/subagent-in-process-driver/run.ts)。

实际 Agent 对象有自身 `context`，且 SubAgent 与 Session 服务按作用域装配，但上述工具传入的最小 `parent` 不提供 Context 或 Session。现有核心请求也没有历史字段，标准 Loop 插件的公开配置没有普通 Fork seed 注入项；[Session Manager](../../../src/agents/plugins/session/session-manager.ts)支持 seed，并不意味着新建 Agent 时已接通此能力。需要第 2 步确定可信父会话取得方式、活动 Session 选择、历史注入入口和其所有权；不能仅按请求中的 ID 信任任意会话。

`createSpawnAgentCreator` 根据可信配置允许的 `presetId` 创建实例，校验并复制每次创建参数，同时拒绝在 Spawn Loop 配置中指定持久化 Session ID。角色工具携带的 ID 目前只到创建参数，角色 Agent 尚未使用它检索资料。Fork 如何支持类型和参数、对历史工具调用或供应商重放状态采用何种兼容策略，均留到第 2 步决定；不意味着所有 Preset 可以直接继承所有父历史。

#### 本步验证范围

已执行 `pnpm run build:tests`，以及 Session、持久化恢复、中断恢复和公开 Spawn 集成的聚焦测试，17 项通过。这些是本项目现有能力的验证；本步未运行官方测试、真实模型或 Fork，也未新增 Provider、修改会话数据或实现历史导入。

### 2. 确定 Fork 契约与兼容范围

**问题与使用方式：** 先确定由谁选择父会话、子类型和初始历史，再实现。输入是可信父实例、任务、取消信号，以及确需的类型和参数；输出是启动句柄或可理解的拒绝原因。

1. 确定捕获父会话的可信入口与精确时机，父实例和服务作用域如何关联；明确没有活动 Session、空历史、已销毁父实例和会话不可读时的处理。
2. 对照官方完成轮次前缀确定项目首版边界，包括当前轮次、失败或取消轮次、工具调用及结果、父 Agent 在捕获后继续写入的情况；以项目实际事件不变量判断能否直接截取，不能依赖未经验证的序号等于数组下标假设。
3. 确定 `presetId`、可信允许范围、创建参数和角色 ID 的支持方式；设计不同 Preset、系统提示词、工具历史、模型供应商及回放数据的兼容规则。明确哪些组合支持、哪些拒绝，以及拒绝发生的位置；必要时先只支持经核实的安全范围，不将限制表述为官方能力。
4. 确定历史传递的所有者和修改点：比较扩展现有创建契约、可信创建闭包和其他已有扩展点，避免让模型自行传入历史、插件配置或适配器。确定内存 / 持久化范围及失败处理。
5. 确定可信代码的调用方式与结果映射。评估是否需要模型可见 Fork 工具，以及通用与角色工具的装配方式；若本阶段需要模型工具，先形成单独明确的接口和步骤，不悄悄改变现有 Spawn 工具语义。

**完成条件：** 记录输入、输出、历史内容和边界、类型与参数策略、授权、兼容性、错误、持久化及测试矩阵；明确需修改的接口和不支持的组合。本步不开发实现。

#### 第 2 步设计结果

本节确定首版方案，后续步骤实现并验证；接口名称仅作设计示意，当前不能调用。Fork 选择如何初始化会话，`presetId` 选择子 Agent 类型，两者独立；目标是让可信代码先完成一次 Fork 委派，不改变现有工具的 Spawn 行为。

**调用与责任：** 在父 Agent 显式装配 `subagent` 和 Fork Provider 后，可信调用方向该父作用域的 `subagents.start('fork', { parent, presetId, prompt, parameters?, signal })` 提交请求。`presetId` 必填，`prompt` 原样交给子 Agent，`parameters` 使用现有每次创建业务参数的语义。成功返回 Run 代表启动已交付，不代表任务结束；调用方等待 `result`，并在成功、失败或取消后释放 Run。模型不得通过这些字段提供任意历史、插件配置、模型适配器或 Session ID。

**可信父会话：** Fork Provider 从自身所在的 Agent Context 取得本作用域的 `agent` 身份和标准 `agentLoop`，不从 `request.parent` 取 Session，也不按请求提供的 ID 查找其他实例。启动时核对请求的父 ID 与 Context 身份一致；不一致、身份或 Loop 服务缺失、服务已关闭均拒绝。给标准 Loop 增加一个只读的 Fork 快照能力，由 Loop 自己读取其持有的 Session；不以 `sessions.list()[0]` 选择会话。此能力与普通 `run / cancel / dispose` 分开声明或作为可选能力，避免声称所有自定义 Loop 都支持 Fork；未提供能力的 Loop 明确拒绝。读取和截取在一次同步调用中完成，尚未调用任何异步创建逻辑；随后父会话继续变化不会改变已获取的事件快照。

该作用域是可信装配边界：Provider 注册在父实例自己的 SubAgent 服务中，获取的 Loop 必须是同一实例装配的服务。实现时验证服务隔离及所有权，不能因为根 Context 恰好提供同名服务就把继承服务当作父实例会话；无法确认归属或会话已关闭时拒绝。空会话与不存在 / 无权访问会话不同：空会话是合法输入，不存在或无法确认归属则是启动错误。

**快照边界：** 以读取到的完整事件数组中最后一个 `turn/end` 的数组位置为切点，包含该事件及其之前全部事件，排除其后的所有事件，包括正在进行的轮次；不将 `seq` 直接当作截取下标。没有 `turn/end` 时产生空历史，子会话按无 seed 初始化。与固定版本官方 Provider 一致，结束原因不作为筛选条件：成功、取消、错误、达到限制和恢复后的中断轮次，只要已有 `turn/end` 都在范围内；最终仍需通过首版兼容校验。调用者不能指定任意时间点或自行裁剪历史。快照只在一次启动中取得一次，不能因创建重试重新读取更晚的父历史。

**历史传递与初始化：** Loop 负责返回受控事件快照；Fork Provider 在首次异步等待前完成父作用域检查、截取与兼容性预检，然后调用共享 Driver，给它一个本次启动专属的可信创建闭包。闭包持有该快照和可信创建配置，Driver 本身仍只负责接收创建函数、提交任务、取消和释放。为标准 Loop 插件增加可信的内存 Session 初始事件配置，由 Fork 创建方传入；它与 `sessionId`、`resumeSessionId` 互斥，不能作为模型工具参数。初始化前复制并校验事件，使用新 Session ID，保证父子事件存储独立；初始化失败由创建方回滚，不能把父 Session 对象直接交给子 Loop。现有普通 Agent 创建者只有显式提供该可信配置才会使用它，不能静默改变 Spawn 行为。

**类型与参数：** Fork 创建方复用项目已有 Preset 注册表和可信配置映射，要求 Preset 存在、已获本父作用域允许且有可用的标准 Loop / LLM 配置；缺省、格式错误、未注册或未允许的 `presetId` 明确拒绝，不回退到其他类型。映射可以按实际任务同时允许 `generic-subagent` 和 `character-agent`，不预建固定数量的实例。`parameters` 按现有 Spawn 的无损 JSON 复制和冻结方式处理，支持角色工具日后传递 `characterId`；此时 ID 仍只是创建参数，不表示已检索角色资料。最终模型、适配器、工具和系统提示词由可信子 Preset 配置决定，不复制父实例的插件、工具注册或授权。

**首版兼容范围：** 为避免把模型私有历史错误地跨类型重放，首版只接受从既有 Session 派生后由文本系统 / 用户 / 助手消息组成的历史，助手消息不得包含工具调用或 `replayState`，也不接受附件等非文本内容；包含工具调用、工具结果、私有重放状态或其他非文本模型内容的已选前缀，明确报历史不兼容，不删除消息、不伪造结果、不改用 Spawn。会话中的运行事件不等于模型消息；额外事件类型若没有经确认的导入语义，首版拒绝，不能静默忽略。空历史和普通文本历史允许交给可信装配中明确配置的通用或角色 Preset；允许某个目标模型接收父历史是可信装配责任，不能将固定替身通过视为所有供应商均兼容。该范围是项目首版的保守限制，不是官方 Fork 的限制；后续支持工具历史或私有状态前须单独设计和验证。

**系统提示与结果：** 复制的是父 Session 的事件前缀；子 Loop 开始新任务时按现有规则组装子 Preset 的系统提示，消息投影取最新系统消息，不能把历史中的父系统提示当作授予子 Agent 的权限。父、子用户与助手文本进入子模型请求的顺序以及子提示词替换行为须在第 3、5 步测试。项目 Driver 直接使用本次 `agent.run()` 返回的文本作为结果；应以子 Agent 空输出测试确认不会误返回父历史回复，不照搬官方事件边界实现。

**持久化与错误：** 首版仅创建独立内存子 Session；持久化父 Session 可以作为只读历史来源，但 Fork 子 Loop 不允许配置 `sessionId` 或 `resumeSessionId`，也不写父存储。自定义插件若会恢复、共享或持久化子 Session，首版不在可信允许范围内；不能静默禁用持久化。父快照读取失败、历史不兼容、类型或配置无效在发布前拒绝并不创建子实例；初始化期间发现错误则等待创建方回滚。发布后任务错误和取消仍按现有 Driver 的 `result` 契约处理，调用者释放 Run；清理失败应可观察且不覆盖原始失败。错误信息可以标明错误类别，不输出父历史、角色资料、凭据或完整配置。

**工具范围：** 本计划先交付可信代码可调用的 Fork Provider，不新增模型可见工具，也不更改 `delegate` 与 `delegate_character` 固定使用 Spawn 的语义。模型将来如何选择 Fork、是否分别封装通用和角色工具，作为后续独立步骤设计；不能因为 Provider 已注册就声称模型能调用 Fork。

#### 实现与验证矩阵

| 输入或时机 | 首版预期 | 对应步骤 |
|---|---|---|
| 父 Loop 无 Fork 快照能力、作用域归属不明、父 ID 不匹配或 Session 已关闭 | 启动拒绝，不读取其他实例历史、不创建子 Agent。 | 3、4、6 |
| 无已结束轮次；或一轮已结束而下一轮正在委派 | 分别继承空历史，或仅继承至最后一个 `turn/end`；包括有结束事件的失败 / 取消轮次。 | 3、5 |
| 捕获后父 Session 继续追加；子 Session 继续执行 | 父子独立，子请求使用启动时的快照；父 Session 不因子任务改变。 | 3、5 |
| 经可信配置允许的通用 / 角色 Preset，角色传入 `characterId` | 选择指定类型和独立实例，参数进入对应实例；角色资料不自动加载。 | 4、5 |
| 未配置或未知 Preset、配置错误，历史含工具调用 / 私有重放状态 / 不支持事件 | 启动明确拒绝，不丢弃历史、不偷偷替换类型，已创建资源按阶段回滚。 | 3、4、5、6 |
| 启动前或创建中取消、父作用域关闭；已交付后取消、重复释放 | 未交付资源回滚，已交付 Run 由持有者释放；错误和清理失败均可观察。 | 4、6 |
| Fork 子项请求持久化、子任务空输出 | 持久化配置拒绝且不更改存储；空输出只返回子任务自己的空结果。 | 3、5、6 |

本步仅形成设计；上述快照能力、初始化配置和 Fork Provider 均尚未实现或通过测试。完成后进入下一步须由用户指示。

### 3. 建立安全的历史快照与独立 Session 初始化

**问题与使用方式：** 根据第 2 步确定的契约，从可信父 Session 获取合法快照，并让新建子 Agent 的 Loop 使用独立 Session；输入为已验证的父历史与子实例配置，输出为已初始化但尚未执行新任务的子实例。

1. 在确定的职责位置实现完成轮次快照和必要校验；检查事件完整性、轮次和工具调用配对，确保快照不会被父子任一方后续变更污染。空历史的行为按第 2 步契约处理。
2. 为现有 Agent / Loop 创建链增加最小必要的可信初始化能力，明确 seed 只能用于新 Session；确认子 Session 拥有独立 ID，轮次与事件序号可继续追加，子系统提示词与继承消息的实际投影符合设计。
3. 处理历史中的工具消息和模型回放信息；对不支持的组合在创建前或可判定的最早位置明确拒绝，不能静默丢弃关键事件或重用父实例的工具、凭据和会话。
4. 按第 2 步决定的持久化范围实现或明确拒绝；覆盖初始化失败后的会话、Agent、持久化句柄回滚。同步受影响的 Session / Loop 文档和接口说明。
5. 测试多轮、无完成轮次、当前轮进行中、空输出、历史含工具调用、父子互相追加、非法或不兼容历史，以及初始化和清理失败；明确断言父 Session 不被改写。

**完成条件：** 可信创建链可产生独立且可继续追加的子 Session，其历史与设计边界一致，失败不遗留资源；尚不声称 Fork Provider 或模型工具已可用。

#### 第 3 步实现与验证

标准 Agent Loop 提供可选的 `ForkHistorySource` 能力：`snapshotForkHistory()` 从自身持有的 Session 截取最后一个 `turn/end` 前缀，并验证其纯文本事件和轮次结构。可信装配可以通过 `initialSessionEvents` 为标准 Loop 创建独立内存 Session；历史与持久化 Session ID 互斥，内容不符合首版约束时拒绝创建。具体接口见 [Agent Loop 说明](../../../src/agents/plugins/loop/README.md)。

[聚焦测试](../../../src/agents/tests/agent-loop-fork-history.test.ts)通过真实 Agent 和固定模型替身验证空历史、进行中轮次截断、独立 Session、子任务使用自己的系统提示和轮次续写，以及未闭合历史、工具事件、私有重放状态和持久化配置的拒绝。Fork Provider、可信父作用域校验和基于 Preset 的 Fork 创建方仍属于后续步骤，本步没有运行 Fork 或真实模型。

### 4. 建立 Fork Provider 并复用 Driver

**问题与使用方式：** 为现有 SubAgent 服务提供进程内 Fork 启动方式。可信调用方提供第 2 步确定的请求，Provider 获取快照并交由创建方建立子实例，Driver 提交任务原文。

1. 在 `src/agents/plugins/subagent/` 按现有工作区规范建立 Fork 包、公开入口、依赖和构建配置；实现 Provider 与 Cordis 插件，通过作用域注册和注销，名称及配置按第 2 步决定。
2. 接通可信父 Session 获取与子 Agent 创建，复用现有 `startInProcessRun`；不将历史导入职责硬编码到共享 Driver。若现有请求或创建接口确有缺口，仅修改必要契约并同步所有调用方。
3. 按确定的规则支持 Preset、业务参数和模型配置；通用与角色委派可选范围由可信装配控制，不能由模型注入插件配置。历史不兼容时拒绝启动并保留父数据。
4. 使用受控替身测试服务路由、Provider 注册注销、输入原样传递、快照捕获一次、句柄与结果分离；覆盖无 Provider、重复注册、配置错误、类型或历史不兼容。
5. 更新包清单、工作区配置、插件汇总与源码目录说明；新增跨模块决策记录，说明会话注入和资源归属。

**完成条件：** 可信代码可通过正式 Fork Provider 启动任务并取得结果、释放运行；Provider 的注册、创建和历史初始化均有独立验证，不依赖模型调用工具。

#### 第 4 步实现与验证

[Fork Provider 包](../../../src/agents/plugins/subagent/subagent-fork-in-process/README.md)在父 Agent 作用域注册 `fork`，核对父身份、SubAgent 服务和标准 Loop 归属，捕获已结束轮次的受限历史，再通过 Driver 与 `createForkAgentCreator` 创建指定 Preset 的独立子 Agent。Agent 完成初始化时为自身 SubAgent 服务绑定身份，避免 Fork 使用继承的根服务。创建方复用 Spawn 的 Preset、模型配置与参数校验；模型工具仍固定选择 Spawn。

[Fork 集成测试](../../../src/agents/tests/subagent-fork-plugin.test.ts)使用正式 Provider、真实 Agent 和固定模型替身，检查角色参数、历史快照、启动与结果分离、运行释放，以及父身份、类型配置和继承根服务的拒绝。更完整的 Spawn / Fork 行为比较与生命周期交错验证属于后续步骤；本步未执行真实模型调用。

### 5. 验证真实 Agent 的上下文与类型

**问题与使用方式：** 使用真实 Factory、Manager、Loop、Session 和正式 Spawn / Fork Provider，固定模型替身只负责产生可检查的输入输出；对照相同父历史下两种方式的区别。

1. 构造父 Agent 已完成的多轮对话和正在进行的委派轮次；验证 Fork 子请求包含设计允许的已完成历史，不包含当前未完成轮次；Spawn 子请求不含父历史，两者均保留任务原文。
2. 检查父、子 Session 和 Agent ID 不同；捕获后父继续写入、子执行与写入均不互相传播。检查父历史中的助手输出不会被当作子任务返回结果。
3. 按第 2 步确定的兼容矩阵，分别验证允许的通用与角色 Preset，以及不允许或不兼容类型的拒绝；若支持角色参数，检查 `characterId` 进入正确实例，不声称资料检索已实现。
4. 验证系统消息、历史工具调用和结果、模型路由及回放状态的实际行为；不能支持的组合应有拒绝测试，不能以替身的一次成功推断所有供应商兼容。
5. 验证多次 Fork 获得不同快照和运行 ID，隔离任务、会话、结果与取消；检查 Manager 内没有完成后遗留的子实例。

**完成条件：** 使用正式 Provider 和真实 Harness 证明设计范围内 Fork 与 Spawn 的差异、类型选择和独立性；未验证的供应商兼容性明确记录。

### 6. 验证取消、失败与资源清理

**问题与使用方式：** 用可控门闩覆盖历史捕获、创建、运行和释放期间的交错，不通过任意延时推断完成。

1. 测试启动前取消、快照失败、创建中取消、会话注入失败、运行中取消、父 Agent 或服务关闭；验证已捕获历史的归属和迟到实例的回滚。
2. 测试任务失败、基础设施异常、释放失败及执行和释放同时失败；错误、取消或部分输出不得伪装成成功，必要时保留两个失败原因。
3. 使用真实 Manager 检查父关闭、重复并发释放和 `disposeAll` 的交错；区分未交付启动由服务 / 创建方处理，与已交付 Run 由持有者负责。
4. 若设计包含持久化，测试创建、种子写入、刷新和回滚失败，检查锁、句柄及数据完整性；若不支持，则验证明确拒绝，不创建或删除持久化数据。

**完成条件：** 各时机的结果和资源所有权可观察；失败与取消不污染父 Session，不遗留无持有者管理的子运行。

### 7. 交付验证与使用说明

**问题与使用方式：** 从公开包入口以可信程序完成装配、Fork、等待结果和释放；让后续开发者知道实际支持什么，以及如何配置和验证。

1. 使用构建后的公开入口、正式 Provider 和固定模型替身做端到端集成；显式验证启动回执早于任务结果、上下文边界、结果和清理。不得使用测试 Provider 冒充正式 Fork。
2. 若第 2 步明确将模型工具纳入本阶段，按已确定的工具契约追加真实父 Loop 的模型调用、工具可见性、角色参数、错误和取消测试；否则记录可信调用已验证、模型工具尚未接入，不改动现有 Spawn 工具。
3. 同步 Fork 包 README、Agent 包说明、Session / Loop 接口说明、工作区结构、架构与 Agent Note；只描述已实现的类型、历史兼容性、持久化和权限边界。
4. 执行受影响的聚焦测试、类型检查、必要构建、文档链接和空白检查；固定替身不代表真实模型调用。若另行运行真实模型，使用可信配置，不记录密钥和完整历史。

**完成条件：** 可信调用能通过正式 Fork 创建独立子 Agent、继承已确认范围的父历史、完成一次任务并清理；支持和拒绝的类型 / 历史组合有证据，文档说明限制。完成后等待用户指示。

## 五、交付与非目标

本计划关注一次性进程内 Fork。后台任务、持续会话、自动结果通知、父子实时共享状态、世界资料或角色档案读取、将建议自动确认为世界事实，均不因 Fork 自动获得；如需开发，应单独确定范围。模型可见 Fork 工具不属于本计划，现有 `delegate` 与 `delegate_character` 仍使用 Spawn。
