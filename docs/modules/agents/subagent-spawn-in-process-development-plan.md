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

输入是父 Agent 身份、任务原文、取消信号，以及可信装配提供的子 Agent 创建依赖和配置。输出是已启动运行的句柄；任务完成后通过 `result` 获得结果，通过 `dispose()` 释放。父 Agent 由程序发起服务调用，不在本阶段验证模型自行决定委派；模型工具和结果通知属于后续步骤。

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
| Session | [Agent Loop](../../../src/agents/plugins/loop/README.md)在不指定持久化 Session ID 时创建内存 Session；显式 `sessionId` / `resumeSessionId` 走持久化路径。 | 验证子 Session 与父 Session 独立且没有父历史；不得复制父级恢复标识、覆盖或删除已有持久化数据。 |
| 工具和作用域 | Factory 对所提供的插件服务建立 Agent 作用域隔离；工具是否可用取决于 Preset 和可信配置。 | 明确子 Agent 工具由何处装配，并验证实际可见性和授权目录；不假设自动继承或自动禁止所有工具。 |

## 三、详细开发步骤

### 1. 对照官方入口，明确职责和调用方式

1. 从官方 `apply()`、Provider 的 `start()` 开始追踪到 Driver 与 Agent 创建服务，确认 Provider、Driver、调用方和创建方的资源所有权。
2. 对照本项目的 [SubAgent 核心服务](../../../src/agents/plugins/subagent/subagent/runtime.ts)、[Driver 入口](../../../src/agents/plugins/subagent/subagent-in-process-driver/run.ts)、Factory、Manager 和现有[驱动集成测试](../../../src/agents/tests/subagent-driver-integration.test.ts)，找出测试用 Provider 与正式 Spawn Provider 的差别。
3. 画出本项目一次调用的顺序：服务查找 Provider、Provider 提供创建能力、Driver 启动、Manager 登记、结果结算、调用方释放。标明 Agent 发布、Run 交付和任务完成的不同时间点。
4. 确定本阶段由可信代码直接调用服务；列出模型工具、父 Agent 结果通知和父子历史继承均不在本步可观察范围。

**完成条件：** 能解释官方 Provider 为什么很薄、本项目需要哪些额外装配，以及每个阶段由谁持有资源；记录源码事实、实测结果与待设计事项。

### 2. 设计可信创建依赖与子 Agent 配置

1. 对照项目包依赖图，确定 Spawn 包如何获得 Manager 的创建和按 ID 释放能力。优先使用已有公开扩展点或可信装配传入的最小能力；避免 Spawn 包反向依赖一个又将其作为内置插件依赖的 Agent 包，不能跨包引用内部源码。
2. 明确该能力的所有者、作用域和关闭顺序：父 Agent 销毁时如何处理未交付创建；已交付运行的释放仍由句柄持有方负责。不能让插件注销隐式销毁已交付的运行。
3. 明确子 Agent Preset 与 `pluginConfigs` 从可信应用或其他已核实的公开入口提供的方式。先验证父 Agent 的 `info` 是否足以提供实际所需数据；无法提供时显式配置或调整最小契约，不能用空值或隐式回退伪装继承。
4. 明确 LLM 路由和适配器、系统提示词、工具与工作目录分别由哪个现有插件装配；要求子 Agent 使用可信授予的配置，不把父 Agent 拥有某能力等同于子 Agent 自动获得该能力。不要把密钥写入测试数据、日志或文档。
5. 设计运行标识和子 Agent ID 的生成者、唯一范围和对应关系。`SubagentRunId` 与 Agent ID / Session ID 是不同用途；即使实现中使用同一原始字符串，也不能在类型和文档中混同。重复 ID 和初始化失败应明确报错，不误删其他实例。
6. 确定全新 Session 的最小装配方式；默认不继承父会话事件，不携带 `resumeSessionId`。如果需要持久化或显式 Session ID，先依据现有后端和版本规则设计隔离与失败策略；本阶段不得覆盖、截断或删除其他会话数据。

**完成条件：** 写清可行的依赖方向、创建与销毁入口、配置来源和 Session 边界；用类型检查及必要的装配验证证明方案能够接入现有 Harness，不提前承诺官方独有能力。

### 3. 建立 Spawn 包并注册 Provider

1. 在 `src/agents/plugins/subagent/` 下建立独立 Spawn 工作区包，参考官方包职责，配置公共入口、构建、类型检查和依赖；更新工作区和实际使用该包的依赖关系。
2. 实现满足 `SubagentProvider` 契约的 Spawn Provider，按项目配置规范确定名称，默认行为对照官方 `spawn`；只加入当前确需的配置和参数。
3. 实现 Cordis 插件，依赖 `subagents` 服务；通过作用域 Effect 注册并在插件卸载时注销。按项目现有插件注册机制接入，使 Preset 可以显式选择；不把测试 Provider 或 Driver 本身注册成插件。
4. 验证缺少依赖、重复名称、非法配置和插件初始化失败时有明确错误；注销后不能发起新的该名称启动，已交付运行保持调用方所有。
5. 验证父 Agent 作用域的 Provider 与该 Agent 的核心服务是同一个注册表，不同 Agent 之间隔离；关闭一个 Agent 不影响另一个 Agent 的注册。

**完成条件：** 不调用真实模型时，实际 Cordis 装配能看到正式 Spawn Provider，注册与注销行为满足核心服务契约。

### 4. 创建全新子 Agent 并接入 Driver

1. 按第 2 步确定的可信创建依赖构造 Driver 的 `InProcessAgentCreator`：通过 Manager 创建子 Agent，返回可执行的 Agent、运行标识及通过同一 Manager 释放该实例的句柄。
2. 将请求交给 `startInProcessRun()`，由 Driver 按原文提交任务并负责运行阶段的取消与清理；Provider 不在原任务前后追加额外提示词。
3. 创建过程不得恢复父会话或使用父会话历史作 seed。通过真实 Session 和固定模型适配器检查模型实际看到的消息，而不是只比较 Session ID。
4. 验证父、子 Agent 和 Session 实例独立；父会话中预先写入的特有内容不进入子模型请求，子任务和子回答也不被当作父会话历史自动写入。子 Agent 的系统提示词、工具和模型请求按实际选定的 Preset / 配置核实。
5. 对输入校验、缺少 Preset / LLM 依赖、初始化失败和 ID 冲突执行拒绝路径。启动失败后核对 Manager 不保留半创建实例；不得清理不属于本次创建的实例。

**完成条件：** 真实 Harness 在固定模型替身下由正式 Spawn Provider 创建独立 Agent，执行给定任务并通过 `Run.result` 得到结果；验证不依赖真实网络或密钥。

### 5. 取消、关闭与资源释放

1. 分别测试创建前取消、创建期间取消、句柄交付后的任务取消，以及任务完成后的取消。现有 Factory 不支持在初始化中直接中断时，按 Driver 契约等待初始化结算后回滚，不声称可立即停止创建。
2. 验证父 Agent 销毁 / 核心服务关闭时，未交付启动会取消并等待回滚；已交付运行仍由调用方释放，不能误以为父 Agent 的退出已自动释放它。
3. 验证 `Run.dispose()` 经过 Driver 调用对应 Manager 的移除入口；多次或并发释放只完成一次清理。完成、执行失败和取消之后，Manager 中不保留该子 Agent；Session / 插件作用域按实际契约关闭。
4. 验证创建期间服务关闭、Manager `disposeAll()` 与父子清理交错不会死锁；用受控门闩测试，不依赖随意的延时。错误路径保留启动与清理失败，遵守核心包的 `SubagentStartupCleanupError` 契约。
5. 并发启动至少两个独立任务，验证 ID、结果、取消与清理互不干扰；记录不支持的跨进程隔离或持久化行为，不将其描述为已经验证。

**完成条件：** 成功、失败、取消和关闭交错都有可观察结果，测试能证明创建方、Driver 与调用方的资源归属；不存在未完成初始化后遗留实例。

### 6. 集成验证与交付

1. 通过真实 Cordis 装配、正式 Spawn 插件、核心服务、Driver、Manager / Factory 和真实 Agent Loop，以固定模型适配器执行完整链路。验证 Provider 不是由测试代码冒充、任务原文和输出正确、启动回执与最终结果可区分。
2. 验证独立 Session、父历史隔离、模型和工具的实际装配、Provider 卸载、失败、取消及资源释放。测试放在 `src/agents/tests/`，使用公开包入口；构建产物测试先显式执行所需构建。
3. 检查是否需要实际模型冒烟：若执行，使用现有可信配置与凭据，不输出密钥或完整敏感配置；缺少可用凭据或网络时明确标注未执行，不把固定替身结果称作真实模型运行。真实模型调用不代替无密钥自动化测试。
4. 更新 Spawn 包 README、Agent 包说明、工作区及根目录结构；生命周期、配置或架构契约变化同步更新对应文档和 Agent Note。文档只写已验证的实际入口，不提前声明工具或自动通知能力。
5. 运行受影响的聚焦测试、类型检查、必要构建、`git diff --check`、新增文件空白与文档链接检查；如有失败，记录具体范围和原因，不把未执行的检查写成通过。

**完成条件：** 可信程序可通过正式 Spawn Provider 创建并完成一次独立子 Agent 任务；文档能说明配置来源、调用方式、结果与清理。完成后等待用户指示，不自动开发 Tool SubAgent。

## 四、交付及限制

交付独立 Spawn 包与 Cordis 注册、可信创建装配、真实 Harness 加固定模型替身的集成测试、必要的文档和决策记录。此时仍不能据此声称模型会自主选择委派、父 Agent 会自动收到异步完成通知，或 Fork / 持续会话已经可用。
