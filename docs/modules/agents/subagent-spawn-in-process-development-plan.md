# SubAgent Spawn In Process 开发计划

本文细化[第三阶段的 Spawn In Process](../../workflows/word-initialization/world-initialization-stage-3-plan.md#3-spawn-in-process)，用于指导实现和验证进程内全新子 Agent。本文是开发计划，示意流程不是已有的生产入口。完成本计划后等待用户指示，再进入 Tool SubAgent 开发。

## 一、解决什么问题

当前核心服务能选择 Provider，共享 Driver 能运行调用方创建的 Agent，但生产环境还没有真正的 Spawn Provider。需要一个可由 Cordis 装配的 Provider：收到一次委派后，使用项目的 Agent 创建能力建立新的进程内子 Agent，启动任务，并把运行句柄交给调用方。

本阶段验证的使用方式是**可信程序代码**通过父 Agent 作用域中的 SubAgent 服务直接发起请求：

```text
可信调用方 → 父 Agent 的 subagents.start('spawn', request)
  → Spawn Provider → 共享 Driver → Agent Manager / Factory
  → 新的子 Agent 和 Session → 执行任务 → Run.result → Run.dispose()
```

输入是父 Agent 身份、任务原文、取消信号、所需子 Agent 类型，以及可信装配提供的创建依赖和允许的配置。类型选择的具体请求字段和省略行为需要先按第 2A 步确定；当前请求尚不包含该选择。输出是已启动运行的句柄；任务完成后通过 `result` 获得结果，通过 `dispose()` 释放。父 Agent 由程序发起服务调用，不在本阶段验证模型自行决定委派；模型工具和结果通知属于后续步骤。

本阶段只建立**全新会话、一次性任务**的 Spawn，任务说明必须携带子 Agent 需要的上下文。它不会自动带入父会话历史，也不会把子 Agent 的建议自动写成用户确认的世界事实。不实现 Fork、持续会话、外部 Provider、模型自主选择或预设固定业务子 Agent 数量。

## 二、官方参考与项目现状

固定参考 DeepSeek Harness commit [`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`](https://github.com/deepseek-ai/deepseek-harness/tree/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent-spawn-in-process)。阅读 [Spawn Provider](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent-spawn-in-process/src/index.ts) 和 [Driver 入口](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent-in-process-driver/src/index.ts)，以源码核对调用链及资源归属。

该版本中，Spawn 插件向 `ctx.subagents` 注册默认名为 `spawn` 的 Provider；一次性 `start()` 调用共享 Driver，不传会话历史 seed。Driver 通过官方 Agent 创建服务创建子 Agent 并执行任务。官方还有模型参数继承、权限策略、结构化输出、深度和持续会话能力，本项目不能仅因参考官方而声称已经支持这些功能。

| 对照项 | Fly Novel 当前事实 | Spawn 实施时要处理的差异 |
| --- | --- | --- |
| 服务和 Provider | [核心服务](../../../src/agents/plugins/subagent/subagent/README.md)按 Agent 作用域注册 Provider，现无生产 Spawn Provider。 | Spawn 插件要向使用它的父 Agent 注册，并随插件作用域注销；不能把单独加载 Driver 当作注册。 |
| Driver | [共享 Driver](../../../src/agents/plugins/subagent/subagent-in-process-driver/README.md)接收调用方提供的创建函数并返回一次性运行句柄。 | Provider 装配创建函数并调用 Driver，不重复实现任务执行、结果映射与运行清理。 |
| 创建能力 | [AgentFactory](../../../src/agents/runtime/agent-factory.ts)负责创建，[AgentManager](../../../src/agents/runtime/agent-manager.ts)负责登记及按 ID 清理；[bootstrap](../../../src/agents/core/bootstrap.ts)返回 Manager，但未将其作为 Agent Context 服务提供。 | 先确定可信装配如何向 Spawn 提供创建与移除能力，并验证生命周期；不能假设 `ctx.agents.create()` 已存在。 |
| 父 Agent | [SubagentStartRequest](../../../src/agents/plugins/subagent/subagent/types.ts)只公开父 Agent 的最小身份视图。 | 它不足以读取父 Agent 模型路由、完整配置或会话；如确需额外能力，先确定无循环依赖的公开接口和调用方。 |
| 模型与 Preset | [Agent 创建参数](../../../src/agents/core/contracts/preset.ts)以 `presetId`、`pluginConfigs` 等指定装配；[LLM 插件](../../../src/agents/plugins/llm/index.ts)需要可信调用方提供适配器和路由。 | 明确子 Agent 的 Preset、模型及适配器从哪里来；不得静默假设父 Agent 的适配器或配置会被复制。 |
| 可创建的类型 | [bootstrapAgents](../../../src/agents/core/bootstrap.ts)注册内置 Preset，[PresetRegistry](../../../src/agents/core/preset.ts)提供查询与列表，[AgentFactory](../../../src/agents/runtime/agent-factory.ts)按 `presetId` 创建并拒绝未注册的 Preset。 | 优先复用现有注册和创建机制；已注册表示框架知道该 Preset，并不表示它的模型配置齐全，也不自动表达某个父 Agent 的委派范围。 |
| Session | [Agent Loop](../../../src/agents/plugins/loop/README.md)在不指定持久化 Session ID 时创建内存 Session；显式 `sessionId` / `resumeSessionId` 走持久化路径。 | 验证子 Session 与父 Session 独立且没有父历史；不得复制父级恢复标识、覆盖或删除已有持久化数据。 |
| 工具和作用域 | Factory 对所提供的插件服务建立 Agent 作用域隔离；工具是否可用取决于 Preset 和可信配置。 | 明确子 Agent 工具由何处装配，并验证实际可见性和授权目录；不假设自动继承或自动禁止所有工具。 |

## 三、详细开发步骤

### 1. 对照官方入口，明确职责和调用方式

1. 从官方 `apply()`、Provider 的 `start()` 开始追踪到 Driver 与 Agent 创建服务，确认 Provider、Driver、调用方和创建方的资源所有权。
2. 对照本项目的 [SubAgent 核心服务](../../../src/agents/plugins/subagent/subagent/runtime.ts)、[Driver 入口](../../../src/agents/plugins/subagent/subagent-in-process-driver/run.ts)、Factory、Manager 和现有[驱动集成测试](../../../src/agents/tests/subagent-driver-integration.test.ts)，找出测试用 Provider 与正式 Spawn Provider 的差别。
3. 画出本项目一次调用的顺序：服务查找 Provider、Provider 提供创建能力、Driver 启动、Manager 登记、结果结算、调用方释放。标明 Agent 发布、Run 交付和任务完成的不同时间点。
4. 确定本阶段由可信代码直接调用服务；列出模型工具、父 Agent 结果通知和父子历史继承均不在本步可观察范围。

**完成条件：** 能解释官方 Provider 为什么很薄、本项目需要哪些额外装配，以及每个阶段由谁持有资源；记录源码事实、实测结果与待设计事项。

#### 官方调用链与责任

以下为固定 commit `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` 的源码行为：

```text
Spawn 插件 apply(ctx, config)
  → 注册 SpawnInProcessProvider（默认名称 spawn）
可信调用方 → ctx.subagents.start('spawn', request)
  → 服务查找 Provider 并校验请求
  → Provider.start(resolvedRequest)
  → startInProcessRun(resolvedRequest, {})
  → 官方 Agent 创建服务发布子 Agent
  → Driver 提交任务并返回 Run → 调用方等待 result、负责 dispose
```

官方 Spawn Provider 的一次性 `start()` 只选择“没有历史 seed”并调用共享 Driver。子 Agent 创建、执行、结果读取和取消释放由 Driver 与 Agent 创建服务完成，因此 Provider 自身代码较少。Spawn 插件的注册生命周期属于 Cordis 作用域；注销不撤销已经交付的运行。官方 Provider 还声明能力并参与持续子会话创建，本阶段不直接照搬未实现的能力。

所有权有三个不同交接点：官方创建服务发布子 Agent 并把 Agent handle 交给 Driver；Provider / Driver 返回 Run 后，核心服务完成自身的交付检查并把 Run 交给调用方；`Run.result` 之后才结算最终结果。运行可以在句柄交付前已经开始，具体任务也可能很快结束，因此不能把这些交接点假定为严格的墙钟时间间隔。启动未交付时由创建方及中间持有者负责回滚；句柄交付后由调用方处理结果并释放。官方还维护本地子级 Session 目录等机制，本项目不能据此假定已有相同能力。

#### 项目已有调用链与验证

现有 [集成测试](../../../src/agents/tests/subagent-driver-integration.test.ts)中的调用顺序是：

```text
测试代码 → 父 Agent 的 subagents.start('test-provider', request)
  → 测试 Provider.start(request)
  → startInProcessRun(request, create)
  → createTestAgent() → AgentManager.create() → AgentFactory.create()
  → Agent 初始化完成并登记到 Manager
  → Driver 调用子 Agent.run({ prompt })，返回 Run
  → 测试代码等待 result，再调用 Run.dispose()
  → 创建句柄通过同一 Manager.dispose(childId) 移除子 Agent
```

测试 Provider 是在测试中定义并通过 Cordis Effect 注册的对象，不是生产 Spawn 插件。它通过闭包取得测试框架的 Manager、固定的子 Agent ID、Preset 和模型替身；[Driver](../../../src/agents/plugins/subagent/subagent-in-process-driver/run.ts)接收该创建函数，不自行从父 Agent 查找 Manager 或配置。[bootstrapAgents()](../../../src/agents/core/bootstrap.ts)将 Manager 作为返回值交给应用，当前没有注册官方式的 `ctx.agents` 创建服务。正式 Spawn 因而仍需解决可信装配如何提供创建、移除、子 Preset 和模型适配器，以及如何避免包循环依赖。

测试已显式构建 LLM、SubAgent 核心包、Driver、Agent 包并编译测试，随后运行 `node --test .test-dist/agents/tests/subagent-driver-integration.test.js`，5 项通过：固定模型成功响应、固定模型错误、运行中取消、创建失败，以及父 Agent 关闭期间延迟创建后的回滚。成功测试还检查 Provider 注销后已交付 Run 仍可取得结果，并在释放后从 Manager 移除子 Agent。这些结果来自固定测试适配器；未验证正式 Spawn 插件、模型自主委派、真实模型、父子 Session 历史隔离或工具授权继承。

#### 下一步需要确定的边界

- **创建与配置从哪里来：** 正式 Provider 必须由可信装配取得 Manager 等创建能力，以及子 Agent 所需 Preset、模型适配器和插件配置；当前父 Agent 的最小身份视图不能提供这些信息。
- **Session 如何保持全新：** 子 Agent 不能恢复或复制父会话。需在正式 Provider 实现后，检查模型实际收到的历史，并按 Session 持久化契约处理显式会话配置。
- **已交付运行由谁释放：** 现有核心服务仅在关闭时处理尚未交付的启动；已交付 Run 由调用方释放。不能假设 Provider 注销或父 Agent 退出会自动清理这些运行。
- **本阶段如何调用：** 先由可信代码直接调用父 Agent 的 `subagents.start()`；模型工具、自主决定委派以及子结果自动通知父 Agent 留待后续步骤。

### 2. 设计可信创建依赖与子 Agent 配置

1. 对照项目包依赖图，确定 Spawn 包如何获得 Manager 的创建和按 ID 释放能力。优先使用已有公开扩展点或可信装配传入的最小能力；避免 Spawn 包反向依赖一个又将其作为内置插件依赖的 Agent 包，不能跨包引用内部源码。
2. 明确该能力的所有者、作用域和关闭顺序：父 Agent 销毁时如何处理未交付创建；已交付运行的释放仍由句柄持有方负责。不能让插件注销隐式销毁已交付的运行。
3. 明确子 Agent Preset 与 `pluginConfigs` 从可信应用或其他已核实的公开入口提供的方式。先验证父 Agent 的 `info` 是否足以提供实际所需数据；无法提供时显式配置或调整最小契约，不能用空值或隐式回退伪装继承。
4. 明确 LLM 路由和适配器、系统提示词、工具与工作目录分别由哪个现有插件装配；要求子 Agent 使用可信授予的配置，不把父 Agent 拥有某能力等同于子 Agent 自动获得该能力。不要把密钥写入测试数据、日志或文档。
5. 设计运行标识和子 Agent ID 的生成者、唯一范围和对应关系。`SubagentRunId` 与 Agent ID / Session ID 是不同用途；即使实现中使用同一原始字符串，也不能在类型和文档中混同。重复 ID 和初始化失败应明确报错，不误删其他实例。
6. 确定全新 Session 的最小装配方式；默认不继承父会话事件，不携带 `resumeSessionId`。如果需要持久化或显式 Session ID，先依据现有后端和版本规则设计隔离与失败策略；本阶段不得覆盖、截断或删除其他会话数据。

**完成条件：** 写清可行的依赖方向、创建与销毁入口、配置来源和 Session 边界；用类型检查及必要的装配验证证明方案能够接入现有 Harness，不提前承诺官方独有能力。

#### 推荐装配方案

由可信应用组装 Spawn 插件时提供创建函数；函数通过闭包持有 Manager 和允许选择的子 Agent 创建配置，并根据每次委派的类型选择解析配置。Spawn Provider 接收委派请求后，把请求和该创建函数交给 `startInProcessRun()`。Spawn 包依赖核心服务和 Driver 的公开入口，创建函数的具体 Manager 适配放在能合法使用 Agent 公共入口的可信装配侧，避免 Spawn 包和 `@fly-novel/agents` 的反向循环依赖。现有 `InProcessAgentCreator` 可接收启动请求，但请求尚无类型选择；具体契约调整按第 2A 步确定，不要求先把 Manager 发布为全局 Context 服务。

这个创建函数是**可信能力**，不是模型可填写的工具参数。其契约必须明确要求创建全新子 Agent 和 Session；只接收任意函数并命名为 Spawn 不能自行证明会话隔离。正式实现必须确定该契约由哪个装配入口负责检查，覆盖允许的 Preset 及其有效的 Loop 配置；使用项目标准 `agent-loop-runtime` 时，应向子 Agent 提供完整、可信的 Loop 配置，并明确拒绝 `sessionId` / `resumeSessionId` 等与本阶段内存新会话目标冲突的配置，不能只检查覆盖前的 Preset 默认值。自定义 Preset 或插件是否满足同一约束，也必须由可信装配确认；无法证明时不能声称 Spawn 总是全新会话。

配置来源按职责区分：子 Preset 决定装配哪些插件和系统提示词；可信应用提供该子实例的 LLM provider、model 和适配器；工具是否存在、工具来源及 `workingDirectory` 等授权配置由选定的子 Preset 与可信应用共同确定。父 `Agent.info` 只有身份、Preset ID 和参数，不包含最终解析的插件配置或适配器；当前方案不自动继承父模型、工具注册或工作目录。父身份是结构化输入，并非已经验证的授权凭证；后续模型工具的授权和父子关系校验需单独设计。

创建方每次调用分别生成运行 ID 与子 Agent ID，运行 ID 转为 `SubagentRunId`，子 Agent ID 交给 Manager；Session 由标准 Loop 在未指定持久化 ID 时独立创建。可使用随机 UUID 降低冲突概率，但随机生成不等于绝对不会冲突：Manager 的 ID 冲突仍须明确拒绝；核心服务不检测运行 ID 冲突，创建方须遵守父 Agent 范围内的唯一性契约。Manager 创建成功后，返回的创建句柄通过**同一个 Manager**移除该子 Agent；创建失败时不得按碰撞 ID 销毁其他实例。若创建方在 Manager 已登记实例之后、交付句柄之前又失败，须自行回滚并按核心契约报告回滚错误。

Provider 注册与创建能力属于父 Agent 的插件作用域；注销阻止后续启动。核心服务关闭会取消并等待未交付的启动，已交付的 Run 不因注册注销而自动销毁，调用方必须处理结果并释放。由于 Manager 不支持中断创建中的初始化，信号在该阶段取消后仍需等待创建结算，再按 Driver 契约回滚。以上是本阶段选择的装配与所有权方向；第三步验证插件配置和请求传递，第四步实现真实创建配置的校验和拒绝路径，不能将本设计中的信任前提当作已经强制执行的代码。

#### 本步装配验证与限制

[装配验证测试](../../../src/agents/tests/subagent-spawn-assembly.test.ts)使用真实 Factory、Manager、Agent Loop 和固定模型替身，由测试中的可信创建函数显式选择子 Preset、独立模型路由和适配器，并分别生成运行 ID 与 Agent ID。两个并发子任务获得不同运行标识、Agent 和内存 Session；子模型请求包含任务原文而不包含父会话历史标记，父 Session 事件数量未因子任务变化。测试中父 Agent 装配了工具服务，而子 Preset 未装配该服务；两个子 Agent 的 Context 均未取得父工具服务。运行释放后 Manager 不再持有子实例。

该测试验证的是现有 Driver 与一种可信装配组合的实际行为，不是正式 Spawn Provider 测试，也没有验证每次委派可选择不同类型。它没有证明任意创建函数或 Preset 都保持新会话，也没有验证具体工具权限、持久化配置拒绝、模型自主委派或真实模型调用。正式插件必须在后续步骤增加这些与其实际职责相关的校验和测试。

### 2A. 设计每次委派的 Agent 类型选择

**要解决的问题：** 调用方需要在发起任务时选择允许使用的 Agent 类型，例如角色 Agent；当前核心启动请求没有类型字段，已有装配测试使用的创建配置也不能证明按请求切换类型。

1. 核对现有 Preset 标识、Agent 身份和 Provider 名称各自的含义。优先评估直接使用已有 `presetId` 和 `PresetRegistry`，只有存在实际差异时才引入额外的类型标识或映射；Spawn 是创建方式，同一类型的多次调用分别创建实例，类型标识也不自动等同于具体世界角色的身份或资料。
2. 明确已注册 Preset 与本次委派可用范围之间的关系，以及由谁提供各类型的模型路由、工具和其他必要配置。优先复用注册表，不另建重复的 Preset 注册表；是否需要按父 Agent 限制可委派的 Preset 由具体应用需求决定，如有限制，在可信装配的父 Agent 作用域中配置和校验，不能仅凭请求中的 `parent.id` 授权。调用方只提交选择标识，不能借此注入任意插件配置或适配器。角色资料如何提供属于后续业务设计，不在此预建。
3. 明确类型选择由谁校验、错误如何返回，以及未提供选择时是要求显式指定还是使用明确配置的默认值；未知、配置不可用或被委派范围限制排除的类型须明确拒绝，不能静默切换为其他类型。区分启动前拒绝和启动成功后的任务失败，并确定选择方案及错误边界。
4. 检查 `SubagentStartRequest`、Provider、`InProcessAgentCreator` 及其调用方，记录最小契约改动及其测试，保留结果、取消和资源归属语义。第 2A 步确定方案，第 3 步落实必要的核心请求契约和调用方修改；Driver 只在现有请求传递能力确实不足时修改。
5. 设计后续 Tool 获取可选类型的信息来源：优先复用现有注册表和可信委派配置，确保工具展示与启动校验基于一致的范围；在 Tool 阶段确定具体公开接口，本步不预建新服务。为后续 Fork 记录需单独设计所选类型与父历史、工具调用记录和授权范围的兼容性；不假设官方固定版本支持任意 Preset 切换。

**完成条件：** 记录选择标识、可信配置来源、默认和拒绝行为、需要调整的公开契约及调用方，并确定测试方式；此步是设计和必要的契约核验，不提前实现 Tool 或 Fork。

**交付检查：** 给出一次可信调用的输入示例与预期调用链，区分已注册 Preset、实际可用配置和按需设置的委派限制；列出缺省、未知标识及配置缺失分别在哪里失败。示例只用于解释设计，不写成已经可运行的生产接口。完成本步后等待用户指示。

#### 本步设计结果

**选择标识与请求：** 建议在核心 `SubagentStartRequest` 增加可选 `presetId?: string`，值直接使用已有 Preset ID，不增加第二套类型名。字段在通用请求中可选，是因为核心服务还允许其他 Provider，而它们不一定使用项目的 Preset；Spawn Provider 则要求该字段为非空且与注册 ID 精确匹配。Spawn 不设置隐式默认值，缺省、空白或带首尾空白的标识均作为启动错误拒绝。是否以及如何支持其他 Provider 的类型选择，在其自身设计中确定。

下列是设计示意，`presetId` 和生产 Spawn Provider 尚未实现，不能直接运行：

```text
subagents.start('spawn', {
  parent: 父 Agent,
  presetId: 'character-agent',
  prompt: '分析任务',
  signal: 取消信号
})
```

**预期调用链：** 核心服务合并取消信号并向 Provider 传递请求；Spawn Provider 校验必填标识后调用 Driver；Driver 把请求交给可信创建函数；创建函数使用同一个框架的 `PresetRegistry` 查询该 ID、解析可信创建配置，再通过对应 `AgentManager` 创建实例。创建函数按同一 Manager 释放实例。Provider / Driver 返回运行句柄，调用方等待 `result` 并在结束后调用 `dispose()`。目前核心服务通过复制请求并替换 signal 来传递字段，现有 Driver 已将请求传给创建函数；字段传递与取消语义仍须在第 3 步通过测试确认。

**配置和可选范围：** 注册表回答 Preset 是否存在，可信应用负责为可用的 Preset 提供模型路由、适配器和插件所需配置；不要求每个已注册 Preset 都能作为子 Agent 成功创建。是否限制父 Agent 可以委派的 Preset 由应用决定；如需限制，创建函数使用该父 Agent 作用域的可信配置校验，而不依据请求自报的父 ID 授权。模型或调用方不能通过 `presetId` 直接指定插件配置、适配器或工作目录。后续 Tool 应基于同一注册表和可信配置得到可展示的选择并在执行时再次校验；目录接口和动态变更处理留待 Tool 设计，不在本步新增服务。

**失败边界：** 缺少或格式错误的 `presetId` 由 Spawn Provider 在调用 Driver 前拒绝；未注册 Preset、明确配置的委派限制、创建前可发现的缺失配置由可信创建函数在 `Manager.create()` 前拒绝。只有初始化期间才能发现的插件或配置错误，由 Factory / Manager 的创建失败路径处理并释放已创建资源。以上均使 `start()` 拒绝且不交付 Run；句柄交付之后的执行错误仍按 Driver 的现有 `result` 契约处理。错误应标明类别和安全的 Preset ID，不输出适配器、凭据或完整插件配置；本步不预先定义新的错误码体系。

**后续实现与验证：** 第 3 步调整核心类型、公开接口说明与相关测试，使用受控创建函数断言 `presetId` 经服务、Provider 和 Driver 原样传递，同时验证未选择类型的其他 Provider 仍可按原契约使用；缺省与非法标识由正式 Spawn Provider 拒绝。第 4 步用现有 `character-agent` 和另一已注册 Preset 验证实际选择，检查角色系统提示词、独立 Session 和重复创建；覆盖未知 Preset、已配置限制和配置缺失，并区分创建前拒绝与初始化失败后的回滚。保留现有取消、关闭和资源释放测试。第 5 阶段设计 Fork 时，再核实历史与不同 Preset 的兼容性，不将此方案描述为固定版本官方 Fork 的已有功能。

### 3. 建立 Spawn 包并注册 Provider

1. 在 `src/agents/plugins/subagent/` 下建立独立 Spawn 工作区包，参考官方包职责，配置公共入口、构建、类型检查和依赖；更新工作区和实际使用该包的依赖关系。
2. 实现满足 `SubagentProvider` 契约的 Spawn Provider，按项目配置规范确定名称，默认行为对照官方 `spawn`；只加入当前确需的配置和参数。
3. 实现 Cordis 插件，依赖 `subagents` 服务；通过作用域 Effect 注册并在插件卸载时注销。按项目现有插件注册机制接入，使 Preset 可以显式选择；不把测试 Provider 或 Driver 本身注册成插件。
4. 验证缺少依赖、重复名称、非法配置和插件初始化失败时有明确错误；注销后不能发起新的该名称启动，已交付运行保持调用方所有。
5. 验证父 Agent 作用域的 Provider 与该 Agent 的核心服务是同一个注册表，不同 Agent 之间隔离；关闭一个 Agent 不影响另一个 Agent 的注册。
6. 实现第 2A 步确定的核心启动请求契约，更新现有 Provider、调用方和受影响的测试；验证类型选择可从服务传递到 Provider 和创建函数，既有取消、结果和清理语义不变。
7. 使用受控创建函数验证 Provider 接入和请求传递；真实 Preset、配置解析及不允许的选择的拒绝路径在第 4 步实现和验证。

**完成条件：** 不调用真实模型时，实际 Cordis 装配能看到正式 Spawn Provider，注册与注销行为满足核心服务契约；必要的请求契约已贯通，受控创建函数能观察到所选类型。完成本步后等待用户指示。

#### 第 3 步的实现与验证

正式 [Spawn 包](../../../src/agents/plugins/subagent/subagent-spawn-in-process/README.md)通过 Cordis 插件注册 `spawn`，接收可信创建函数，并在调用 Driver 前拒绝缺失、空白或带首尾空白的 Preset ID。核心请求增加可选 `presetId`，其他 Provider 仍可不使用该字段。测试以受控创建函数验证请求传递、Agent 作用域隔离、非法请求、缺少创建配置及已交付句柄的释放；实际 Preset 校验、Manager 创建与独立 Session 仍属于第 4 步。

### 4. 创建全新子 Agent 并接入 Driver

1. 按第 2、2A 步确定的可信创建依赖与选择契约构造 Driver 的 `InProcessAgentCreator`：解析已注册 Preset 与可信配置，通过 Manager 创建子 Agent，返回可执行的 Agent、运行标识及通过同一 Manager 释放该实例的句柄。明确在 Provider 或创建方执行选择校验，并确保拒绝发生在创建实例之前。
2. 将请求交给 `startInProcessRun()`，由 Driver 按原文提交任务并负责运行阶段的取消与清理；Provider 不在原任务前后追加额外提示词。
3. 创建过程不得恢复父会话或使用父会话历史作 seed。通过真实 Session 和固定模型适配器检查模型实际看到的消息，而不是只比较 Session ID。
4. 验证父、子 Agent 和 Session 实例独立；父会话中预先写入的特有内容不进入子模型请求，子任务和子回答也不被当作父会话历史自动写入。子 Agent 的系统提示词、工具和模型请求按实际选定的 Preset / 配置核实。
5. 对输入校验、缺少 Preset / LLM 依赖、初始化失败和 ID 冲突执行拒绝路径。启动失败后核对 Manager 不保留半创建实例；不得清理不属于本次创建的实例。
6. 使用至少两种可委派的 Preset 配置验证逐次选择会创建对应类型，其中包括现有 `character-agent`；检查实际 Preset 与角色系统提示词装配。重复选择同一类型仍得到独立 Agent 和 Session。验证未提供、未知、配置不可用及配置了限制时被排除的选择符合第 2A 步确定的行为：可在创建前判断的错误不调用 Manager 创建；初始化时才能发现的错误须回滚，Manager 不保留实例。

**完成条件：** 真实 Harness 在固定模型替身下由正式 Spawn Provider 按请求选择 Preset、创建独立 Agent，执行给定任务并通过 `Run.result` 得到结果；验证不依赖真实网络或密钥。完成本步后等待用户指示。

### 5. 取消、关闭与资源释放

1. 分别测试创建前取消、创建期间取消、句柄交付后的任务取消，以及任务完成后的取消。现有 Factory 不支持在初始化中直接中断时，按 Driver 契约等待初始化结算后回滚，不声称可立即停止创建。
2. 验证父 Agent 销毁 / 核心服务关闭时，未交付启动会取消并等待回滚；已交付运行仍由调用方释放，不能误以为父 Agent 的退出已自动释放它。
3. 验证 `Run.dispose()` 经过 Driver 调用对应 Manager 的移除入口；多次或并发释放只完成一次清理。完成、执行失败和取消之后，Manager 中不保留该子 Agent；Session / 插件作用域按实际契约关闭。
4. 验证创建期间服务关闭、Manager `disposeAll()` 与父子清理交错不会死锁；用受控门闩测试，不依赖随意的延时。错误路径保留启动与清理失败，遵守核心包的 `SubagentStartupCleanupError` 契约。
5. 并发启动至少两个独立任务，验证 ID、结果、取消与清理互不干扰；记录不支持的跨进程隔离或持久化行为，不将其描述为已经验证。

**完成条件：** 成功、失败、取消和关闭交错都有可观察结果，测试能证明创建方、Driver 与调用方的资源归属；不存在未完成初始化后遗留实例。完成本步后等待用户指示。

### 6. 集成验证与交付

1. 通过真实 Cordis 装配、正式 Spawn 插件、核心服务、Driver、Manager / Factory 和真实 Agent Loop，以固定模型适配器执行完整链路。验证 Provider 不是由测试代码冒充、任务原文和输出正确、启动回执与最终结果可区分。
2. 验证独立 Session、父历史隔离、模型和工具的实际装配、Provider 卸载、失败、取消及资源释放；验证可信调用方能够逐次选择可委派的类型，以及被拒绝的选择不会创建实例。测试放在 `src/agents/tests/`，使用公开包入口；构建产物测试先显式执行所需构建。
3. 检查是否需要实际模型冒烟：若执行，使用现有可信配置与凭据，不输出密钥或完整敏感配置；缺少可用凭据或网络时明确标注未执行，不把固定替身结果称作真实模型运行。真实模型调用不代替无密钥自动化测试。
4. 更新 Spawn 包 README、Agent 包说明、工作区及根目录结构；生命周期、配置或架构契约变化同步更新对应文档和 Agent Note。文档只写已验证的实际入口，不提前声明工具或自动通知能力。
5. 运行受影响的聚焦测试、类型检查、必要构建、`git diff --check`、新增文件空白与文档链接检查；如有失败，记录具体范围和原因，不把未执行的检查写成通过。

**完成条件：** 可信程序可通过正式 Spawn Provider 创建并完成一次独立子 Agent 任务；文档能说明配置来源、调用方式、结果与清理。完成后等待用户指示，不自动开发 Tool SubAgent。

## 四、交付及限制

交付独立 Spawn 包与 Cordis 注册、可信创建装配、真实 Harness 加固定模型替身的集成测试、必要的文档和决策记录。此时仍不能据此声称模型会自主选择委派、父 Agent 会自动收到异步完成通知，或 Fork / 持续会话已经可用。
