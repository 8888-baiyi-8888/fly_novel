# SubAgent 进程内共享运行驱动开发计划

本文细化[第三阶段的进程内共享运行驱动](../../workflows/word-initialization/world-initialization-stage-3-plan.md#2-进程内共享运行驱动)。本文是开发步骤与验证计划，不是已经可运行的接口说明。完成本计划后等待指示，再进入 Spawn Provider 开发。

## 一、目标与边界

建立供进程内 Spawn 和 Fork Provider 共用的**一次性运行驱动**：获取一个独立的子 Agent，提交一项任务，返回可等待结果和释放资源的运行句柄。先通过模拟 Agent 和可控的创建替身验证行为，不连接真实模型。

输入包括现有 SubAgent 启动请求和创建子 Agent 所需的最小依赖；输出为符合 `SubagentRun` 契约的句柄，包含运行标识、异步结果和 `dispose()`。启动成功只表示运行已交付，任务最终结果通过 `result` 获取。

职责边界：

| 组件 | 职责 |
| --- | --- |
| SubAgent 核心服务 | 注册和查找 Provider、分发启动请求，管理尚未交付的启动；契约见[核心包说明](../../../src/agents/plugins/subagent/subagent/README.md)。 |
| Spawn / Fork Provider | 定义各自的创建方式与初始上下文，注册到核心服务，并调用共享 Driver。 |
| 共享 Driver | 按约定取得子 Agent，启动一次任务，将结果、取消与释放适配到 `SubagentRun`。 |
| Agent Factory / Manager | 按各自契约创建、登记和销毁项目 Agent；Driver 不把二者当作同一个对象。 |
| 调用方 | 接收已交付的运行，处理结果并最终释放句柄。 |

本计划不实现 Spawn 或 Fork Provider、模型委派工具、自动通知父 Agent、真实模型请求、持久化迁移和多级委派。Fork 的历史提取和注入留给后续步骤；为了复用而需要的参数，只在确认项目可支持且当前验证确有需要时引入，不预建不可用的历史导入能力。

## 二、官方参考与项目差异

固定参考 DeepSeek Harness commit [`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`](https://github.com/deepseek-ai/deepseek-harness/tree/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent-in-process-driver)。从 [Driver 的 `startInProcessRun`](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent-in-process-driver/src/index.ts) 向下阅读，再对照 [Spawn](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent-spawn-in-process/src/index.ts) 和 [Fork](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent-fork-in-process/src/index.ts) 的调用入口。

该版本中，一次性 Provider 调用 Driver；Driver 经父 Agent 上下文中的 Agent 创建服务建立子 Agent，发布后提交任务，从子 Session 中提取子 Agent 的结果，并返回含 `result` 和 `dispose()` 的句柄。Spawn 不传历史种子，Fork 传入父会话已完成轮次的前缀。官方创建事务支持启动取消和发布前配置，不能直接假设本项目已有相同能力。官方的持续会话走另一条管理路径，不通过这个一次性 Driver。

| 对照项 | 项目当前事实 | 开发时需要解决的问题 |
| --- | --- | --- |
| 父 Agent | [SubagentStartRequest](../../../src/agents/plugins/subagent/subagent/types.ts) 只暴露父 Agent 的最小身份视图。 | Driver 如何取得创建子 Agent 所需能力，同时避免核心包与 `@fly-novel/agents` 的循环依赖；不跨包引用内部源码。 |
| 创建和登记 | [AgentFactory](../../../src/agents/runtime/agent-factory.ts) 创建实例；[AgentManager](../../../src/agents/runtime/agent-manager.ts) 管理创建、ID 冲突和销毁。 | 明确谁拥有创建和释放职责；经 Manager 创建的实例应由对应 Manager 移除，不能只销毁 Agent 而留下登记。 |
| 创建期间取消 | 现有 `CreateAgentOptions` 和 Factory 创建入口没有取消信号。 | 定义取消发生在创建前、创建期间、创建完成交接时的处理和等待边界；不能声称能够中断尚未支持取消的初始化。 |
| 运行与结果 | [Agent](../../../src/agents/core/contracts/agent.ts) 的 `run({ prompt })` 成功返回文本，失败以 Promise 拒绝；`cancel()` 不接收信号。 | 明确任务失败、取消和基础设施故障的映射，不能仅因信号已取消就吞掉不相关的清理或持久化错误。 |
| Session 与 Fork | [Agent Loop](../../../src/agents/plugins/loop/README.md) 持有 Session；持久化恢复和普通 Session seed 存在，但公开 Agent 创建入口没有官方式的 Fork 历史参数。 | 不将内部 Session seed 等同于可用的 Fork 接口；历史边界及持久化兼容留到 Fork 设计时确认。 |
| 关闭边界 | 核心服务关闭会取消并等待尚未交付的启动；已交付句柄由调用方释放。 | Driver 的发布、监听器交接与清理必须和核心服务一致，避免重复释放或产生无人持有的运行。 |

Manager 的单实例清理和整体关闭必须允许父 Agent 等待子 Agent 释放，具体行为见 [Agent 包说明](../../../src/agents/README.md)。启动回滚失败由核心服务按[核心包说明](../../../src/agents/plugins/subagent/subagent/README.md)报告。

## 三、详细开发步骤

### 1. 追踪官方与核实项目调用关系

1. 按 `Provider.start()` → `startInProcessRun()` → Agent 创建 → 单次执行 → `result` / `dispose()` 的顺序阅读固定版本源码，标记发布前后资源所有者。
2. 阅读项目的 [Agent Factory](../../../src/agents/runtime/agent-factory.ts)、[Agent Manager](../../../src/agents/runtime/agent-manager.ts)、[Agent 实例](../../../src/agents/core/agent.ts)、[Agent Loop](../../../src/agents/plugins/loop/README.md) 和[核心服务](../../../src/agents/plugins/subagent/subagent/runtime.ts)，对照实际创建、取消与销毁路径。
3. 确认 `AgentManager.create()` 初始化完成后才登记，`dispose(id)` 如何等待初始化、移除并销毁；核查失败时的清理和错误传播。确认项目 `Agent.run()` 返回值与官方 Session 结果提取方式的不同。
4. 整理可复用的能力、尚缺的创建取消能力和当前不支持的官方功能。必要时用受控替身验证交接时序，区分实测结果与源码推断。

**完成条件：** 能画出一条官方一次性调用链，并说明项目对应入口、创建发布边界及主要差异；不实现后续 Provider。

#### 固定版本的官方一次性调用链

以下是官方 commit `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` 的源码行为，不代表本项目已有同样实现：

```text
SubagentRuntime.start(name, request)
  → Provider.start(resolvedRequest)
    → startInProcessRun(request, options)
      → parent.ctx.agents.create(创建参数、signal、setup)
      → drivePublishedRun(handle, signal, prompt, ...)
        → child.followup(用户消息) → child.whenIdle()
        → 从子 Session 的运行边界之后读取结果
        → 返回 { id, localAgent, result, dispose }
```

1. Spawn 的 `start()` 不传 Session seed；Fork 先截取父 Session 中最后一个已完成 `turn/end` 为止的事件前缀，再把非空 seed 交给 Driver。当前未完成轮次不作为 Fork 历史。
2. Driver 在创建前检查信号、计算深度和子 Session 标识，准备按请求定制子作用域的 `setup`，再调用官方 Agent 创建服务。官方创建服务在未发布阶段持有创建事务，负责失败回滚；返回 handle 后子 Agent 已在其 Agent 注册表发布。
3. `drivePublishedRun()` 为已发布的子 Agent 安装取消监听器，并在安装后再检查一次信号，覆盖创建事务与运行监听器之间的交接。随后它提交子任务，启动异步结果收集并返回运行句柄；**子 Agent 在 Agent 注册表发布**与**运行句柄交给 SubAgent 服务的调用方**是两个不同的交接点。
4. `result` 等待子 Agent 空闲，从 seed 边界之后的 Session 事件选择子 Agent 的最终输出和终止原因；结束时移除取消监听器。`dispose()` 等待官方 Agent handle 的释放和结果结算，释放错误由清理通道报告。Provider 卸载不撤销已交付的运行。
5. 官方还处理深度、策略继承、结构化输出和 Session 描述符。本步只确认它们存在；它们不是本项目当前 Driver 的既有能力，也不因为对照官方而自动纳入本步骤。

#### Fly Novel 的对应路径与验证

1. `AgentManager.create(options)` 先检查 ID 冲突并记录正在初始化的创建 Promise，调用 `AgentFactory.create()`；Factory 解析 Preset、隔离服务并等待 `AgentInstance.initialize()`。初始化成功后 Manager 才把 Agent 放入实例表；失败时 `initialize()` 尝试清理作用域，Manager 清除待创建记录。Factory 和 Manager 创建入口目前没有取消信号。
2. `AgentManager.dispose(id)` 若存在待初始化项则等待其结算，再从实例表移除并调用该 Agent 的 `dispose()`；不存在时返回。`disposeAll()` 等待已登记的初始化，按实例登记的相反顺序销毁，并汇总清理错误。单实例清理和整体关闭的协调及测试见第 5 步。
3. `AgentInstance.run({ prompt })` 将输入交给当前作用域的 `agentLoop`；项目 Loop 成功时直接返回 `{ content }`，失败以 Promise 拒绝。Loop 将 Turn 终止信息写入 Session，取消使用 `Agent.cancel()`，而不是接收外部信号。任务与结束记录或刷新同时失败时，Loop 可能抛出 `AggregateError`。
4. Agent 销毁先等待 Loop，再关闭自身显式装配的 SubAgent 服务，最后释放插件作用域；SubAgent 服务取消并等待未交付的启动，已交付句柄由持有方负责。服务与 Manager 的跨对象回滚错误如何同时报告，仍须按第 3 步验证。

实际执行了 `node --test --test-name-pattern '初始化失败时清理|拒绝缺少 loop|清理 Manager 会等待|销毁 Agent 等待|清理失败会报告' .test-dist/agents/tests/harness.test.js .test-dist/agents/tests/subagent-plugin.test.js`，此前显式构建了 SubAgent 包、Agent 包并编译测试；5 项测试通过。它们验证了初始化失败清理、ID 冲突、Manager 等待初始化、Agent 关闭等待未交付启动和迟到句柄清理失败的报告；这些测试未运行 Driver，也未验证 Manager 整体关闭与 Driver 回滚之间的潜在循环等待。

当前可复用的是 Agent 的单轮运行、取消和释放，以及 Manager 的创建与登记能力。Driver 仍需确定如何以无环方式获得实际创建能力、在不能中断初始化时如何等待并回滚，以及如何映射任务和持久化错误；Fork 历史导入、真实 Provider 与父子通知尚未实现。

### 2. 确定创建依赖、类型与包组织

1. 在 `src/agents/plugins/subagent/` 下按官方包组建立独立 Driver 工作区包，登记公开入口、构建与测试配置；包名、依赖和最终目录以仓库规范及官方职责为依据。
2. 设计 Driver 接收的最小创建能力：必须能取得可运行、可取消、可等待释放的子 Agent，以及对应创建方负责的移除操作。先对照真实 Manager 契约和调用关系，再决定依赖注入方式；不直接依赖 Provider 的具体实现。
3. 明确 Provider、Driver 和 Agent 包的依赖方向，避免 `@fly-novel/agents` 汇总插件时形成工作区循环。若确需调整现有公开契约，先说明变更及所有调用方，保持改动限于实现本步骤所必需范围。
4. 复用 `SubagentStartRequest`、`SubagentResult` 和 `SubagentRun`，只补充当前驱动必需的类型。运行标识由谁分配、与 Agent ID / Session ID 的关系及唯一性范围应明确，不能假设它们相同；遵守核心包中 Provider 对父 Agent 范围唯一性的约定。
5. 定义启动失败、任务终态和无法表示的基础设施异常分别如何传递；任务内容原文交给子 Agent，不附加未要求的提示词。
6. 用未来 Fork 的需求走查创建依赖：确认后续可以向创建方提供独立会话的初始化信息，而不把 Driver 固定为只能创建全新会话。此步不实现历史提取、seed 参数或 Fork Provider，实际接口以 Fork 设计和项目 Session 契约为准。

**完成条件：** 可以通过包公开入口定义一个模拟创建方和模拟 Agent，类型检查通过，依赖图无循环；契约没有假装支持 Fork、真实 Session 创建或模型路由继承。

本步的类型和所有权说明见 [Driver 包说明](../../../src/agents/plugins/subagent/subagent-in-process-driver/README.md)。调用方提供创建函数，成功后返回包含运行标识、Agent 能力及创建方释放入口的句柄；可通过闭包携带创建配置，Driver 包只依赖 SubAgent 核心包。类型检查验证项目 Agent 可以满足运行接口，并可由调用方将 Manager 的创建和按 ID 移除适配为创建函数；该适配仅用于类型验证，尚未实现或验证实际 Driver。创建方分配的运行标识需遵守核心契约的唯一性要求，不能假定它必然等于 Agent ID 或 Session ID。具体任务错误映射和取消交接留待第 3 至第 5 步按真实运行行为实现和验证。

### 3. 实现创建与发布边界

1. 创建前检查取消信号；已取消时不调用创建方。
2. 调用创建方取得子 Agent 和清理能力。明确 Driver、创建方和调用方各自何时拥有资源；未发布时创建失败由约定的创建方回滚，不产生可用句柄。
3. 处理创建期间取消：如果创建接口尚不能中断，等待创建结算；成功返回但尚未交付时立即释放并拒绝启动，失败则保留可观察的启动与清理错误。不得让后台初始化完成后留下无人持有的 Agent。
4. 在发布交接处处理取消竞态：取消监听器安装与信号状态检查之间不能漏掉取消；清理完成前不能声称运行已完全停止。
5. 启动成功时返回句柄而不等待任务结果；测试使用可控 Promise 分别控制创建、任务和清理，验证启动失败、延迟创建与交接竞态。
6. 当核心服务因关闭而取消尚未交付的启动，模拟 Driver 回滚失败并拒绝；分别验证启动调用方和服务关闭调用方是否能观察失败。若关闭方无法获知，调整核心服务以传播必要的清理错误，并测试普通启动失败与关闭期间回滚失败的区别。

**完成条件：** 启动失败不交付句柄；成功交付后的运行有明确持有者；取消或关闭交错时没有未释放的模拟实例。

本步提供 `createInProcessAgent()` 作为创建交接入口，行为与资源归属见 [Driver 包说明](../../../src/agents/plugins/subagent/subagent-in-process-driver/README.md)。它不执行任务，也不负责句柄交付后的取消监听；后者留待后续步骤。创建方回滚失败使用核心包的 `SubagentStartupCleanupError`，服务关闭期间该错误同时报告给启动调用方和关闭调用方；普通启动失败不被误报为关闭失败。模拟测试覆盖创建前取消、创建失败、创建中取消、异步回滚及回滚失败；真实 Factory / Manager 与 Driver 的组合仍须在第 6 步验证。

### 4. 执行任务与收集结果

1. 对取得的子 Agent 调用一次 `run({ prompt })`，保持输入原文；将成功返回的 `content` 映射为 `SubagentResult` 的 `output` 和 `completed`。
2. 按实际错误类型与取消状态设计 `error`、`aborted` 和结果 Promise 拒绝的边界；保留重要失败信息，避免记录密钥或敏感输入。若当前契约不足以可靠区分错误，先明确缺口和最小调整，不通过宽泛捕获把所有异常伪装为成功的结果。
3. 明确取消与完成同时发生时的顺序：已经完成的结果不因之后的取消被改写；尚未完成的任务需要响应取消。测试正常完成、任务失败、基础设施异常、空输出和取消。
4. 保证 `result` 的处理不造成未处理的 Promise rejection，且清理期间发生的异常不会覆盖原本的任务失败。
5. 实现前列出并测试具体错误映射：`LlmError` 的 `ABORTED`、普通任务失败、不能归入任务终态的基础设施错误，以及任务失败与结束记录或持久化刷新失败组成的 `AggregateError`。以稳定错误类型和错误码判断，不解析错误文本；聚合错误中的记录或清理失败必须保留，不能仅因信号已取消而归为普通 `aborted`。

**完成条件：** 一个模拟 Agent 接收原始任务并返回可区分的终态；不同错误与取消路径可由测试验证。

`startInProcessRun()` 的输入、结果和错误映射见 [Driver 包说明](../../../src/agents/plugins/subagent/subagent-in-process-driver/README.md)。模拟测试验证任务原文、空输出、LLM 错误码、取消、未知异常和聚合错误，以及结果失败与清理失败分别可观察。该步骤已实现基本取消转发和释放入口；并发释放、Manager 关闭交错及真实 Factory / Manager 的集成验证仍按后续步骤完成。

### 5. 实现取消与资源清理

1. 发布后将请求信号传递到子 Agent 的取消入口，并在结果结算或运行释放后移除监听器；取消一个运行不影响其他运行。
2. `dispose()` 取消未完成工作，等待运行和创建方负责的释放结束；并发及重复调用共享一次清理结果。已完成任务的结果不因释放而改变。
3. 明确结果失败与释放失败分别由哪个 Promise 报告；若两者同时发生，确保两个失败都可观察，不遗漏错误或产生未处理的拒绝。
4. 验证取消前、执行中、执行后、创建交接和并发释放等顺序；验证取消监听器移除、清理失败可见及两个并发运行互不干扰。
5. 将实际可能的竞争写成确定性测试，不依赖定时等待或真实模型；不凭空假设内部静态类型可能产生无效值。
6. 使用真实 Agent Manager 验证 `disposeAll()` 与父 Agent 关闭、子 Agent 创建或移除交错时不会循环等待。尤其覆盖父 Agent 清理等待 Driver，而 Driver 通过同一个 Manager 释放子 Agent 的情况；测试应使用受控门闩与可明确判定的完成条件。若暴露现有 Manager 生命周期缺陷，先修正并覆盖，不通过跳过 Manager 的登记清理掩盖问题。

**完成条件：** 所有测试路径都能说明 Agent、运行句柄和监听器的最终归属；清理可重复且不会提前返回。

Driver 的并发释放、取消监听器清理及错误传播见 [Driver 包说明](../../../src/agents/plugins/subagent/subagent-in-process-driver/README.md)。Manager 允许整体关闭期间按 ID 释放其他 Agent，并为同一 Agent 的并发释放共享结果；真实 Manager 测试覆盖父 Agent 清理等待 Driver，再由 Driver 通过同一 Manager 释放子 Agent。测试也验证清理期间不能复用 Agent ID。该验证使用固定模型替身，完整的 Provider 创建链路仍留待第 6 步。

### 6. 组合验证、文档与检查

1. 在测试中使用模拟 Provider 把核心服务连接到 Driver 和模拟创建方：`SubagentRuntime.start()` → Provider → Driver → 模拟 Agent → 句柄 → 结果与释放。该 Provider 只作测试夹具，不作为 Spawn 实现。
2. 验证核心服务在启动期间关闭时与 Driver 的取消、发布和清理约定一致；同时验证 Provider 注销不撤销已经交付的运行。
3. 确认测试通过公开包入口引用依赖；测试放在 `src/agents/tests/`，构建产物检查先显式构建所需包。
4. 更新 Driver 包 README、Agent 包说明、工作区及根目录结构；涉及生命周期和跨包接口的决定写入 Agent Note。若改动已有架构契约，同步更新对应文档。
5. 运行受影响的聚焦行为测试、类型检查、必要构建和 `git diff --check`，检查新增文件空白与文档链接。以实施时实际脚本为准，只报告真实执行的命令与结果。
6. 增加不访问真实模型的项目集成测试：使用真实 Agent Factory 和 Manager、现有固定模型替身以及测试用 Provider，把 Driver 连接到实际创建与销毁路径。验证创建后 Manager 可查询子 Agent，句柄释放后 Manager 中不再保留该实例，独立运行的成功、失败与取消符合契约。该测试不代替后续真实 Spawn Provider 和 Session 隔离验证。

**完成条件：** 模拟委派链路以及真实 Factory / Manager 与固定模型替身的集成验证均可复现；公开文档说明输入输出、所有权和限制。真实 Spawn / Fork Provider、其 Session 隔离和模型自主委派仍须在各自步骤验证。

## 四、交付与暂停点

交付独立 Driver 包、模拟 Agent / 创建方测试、与核心服务及真实 Factory / Manager 的聚焦集成测试，以及必要的接口说明与决策记录。完成后整理已验证的调用链、实际运行的检查和遗留问题，等待用户指示；不自动进入 Spawn Provider 的开发。
