# SubAgent 核心服务开发计划

本文细化[第三阶段的 SubAgent 核心服务](../../workflows/word-initialization/world-initialization-stage-3-plan.md#1-subagent-核心服务)，用于指导实现和逐步验证。完成本计划后等待确认，再进入进程内共享运行驱动的开发。

## 目标与范围

建立一个 Cordis 可装配的 SubAgent 核心服务：调用方注册具名 Provider，按名称提交任务，获得代表一次运行的句柄，并能等待结果和释放资源。使用模拟 Provider 验证这一链路；本步骤不创建真实子 Agent、不接入模型工具，也不实现消息通知、持续会话、持久化或多级委派。

输入是调用方提供的 Provider 名称、父 Agent 身份、任务内容和取消信号；输出是启动成功后的运行标识、结果和清理入口。启动失败直接报错，不能伪装成任务结果。具体字段以实现前对照源码和项目契约后的设计为准，避免提前引入模型路由、工具权限等当前不使用的选项。

## 参考与现有基础

本计划固定参考 DeepSeek Harness commit [`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`](https://github.com/deepseek-ai/deepseek-harness/tree/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent)。该版本的 [`src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent/src/index.ts) 提供服务、Provider 注册和一次性启动入口；[`src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/subagent/src/types.ts) 定义请求、Provider、运行句柄和结果；持续会话管理位于 `continuation.ts`、`continuation-activation.ts` 等文件。该提交没有阶段计划所列的 `manager.ts` 和 `activation.ts`，阅读时以固定版本实际文件为准。

官方服务的一次性 `start()` 在 Provider 发布运行后返回句柄；句柄中的结果异步结算，调用方负责释放。Provider 在发布前负责失败清理。官方还提供持续会话及其他能力，本步骤仅借鉴与一次性模拟启动有关的职责和所有权边界，不声称两者接口或完整行为相同。

项目的 [Agent 契约](../../../src/agents/core/contracts/agent.ts)提供实例身份、运行、取消和销毁；[Agent Manager](../../../src/agents/runtime/agent-manager.ts)管理普通 Agent 实例，并不管理委派关系。当前 Agent 的 `run()` 返回文本结果，尚无官方所需的子 Agent 持续会话及通知接口。核心服务不直接调用 Factory 或把现有 Agent Manager 当作官方 SubAgent 管理器。

## 开发步骤

### 1. 对照入口与划定职责

1. 从官方 `registerProvider()`、`getProvider()` 和一次性 `start()` 出发，阅读其调用的必要代码，再核对 `SubagentProvider`、`SubagentRun` 和 `SubagentResult`。
2. 对照项目 [Harness 使用说明](../../../src/agents/README.md)、[插件注册汇总](../../../src/agents/plugins/index.ts)、[Agent Factory](../../../src/agents/runtime/agent-factory.ts) 和现有插件测试，确认 Context 作用域与插件装配方式。
3. 写出职责边界：服务负责注册、查找、启动路由及本步骤约定的运行标识；Provider 负责具体启动；调用方接收句柄并负责释放。标出官方依赖的 Session、事件和持续会话能力，不将其假定为项目已有能力。
4. 确认服务实例的作用域，以及后续 Provider 如何与调用方访问同一注册表；使用实际 Cordis 装配验证，不能仅凭类型声明推断服务共享。

**完成条件：** 能说明从调用方到 Provider 的输入输出、启动发布边界和服务作用域，并列出本步骤不实现的官方能力。

### 2. 建立核心包与最小契约

1. 在 `src/agents/plugins/subagent/` 下按官方包组组织建立核心服务包；其余 Provider、Driver 和工具留在后续步骤，不预建空包。具体子目录和包名在核对项目工作区和官方命名后确定。
2. 定义本步骤需要的启动请求、终态结果、运行句柄和 Provider 契约。至少表达任务内容、父身份、取消信号、运行标识、异步结果和异步清理；区分 Agent 身份与运行标识，避免混用。
3. 明确启动 Promise 成功只表示 Provider 已发布运行；任务成功、任务失败和取消通过结果表达，启动失败通过拒绝表达。基础设施异常如何传播须在契约和测试中明确，不静默吞错。
4. 明确取消和清理的所有者：发布前 Provider 负责回滚；发布后由句柄持有方调用清理。清理应可重复调用并等待资源结束；取消信号在启动前后如何传播须由契约明确。
5. 按仓库包规范配置公共入口、构建与类型检查，更新工作区及必要的构建、测试引用；只引入核心包实际使用的依赖。

**完成条件：** 类型检查能验证模拟 Provider 与调用方通过公开契约协作，包的依赖方向不要求真实 Spawn Provider 或工具包。

### 3. 实现 Provider 注册与查询

1. 实现按名称注册和查找；同一服务中重复名称明确拒绝，未知名称启动明确报错。
2. 注册返回注销函数，约定重复注销的行为；注销后禁止新启动，已经返回的运行句柄仍由持有方管理。
3. 在服务作用域结束时清理注册。避免旧注销函数误移除同名的新注册；无需为当前需求添加 Provider 能力目录或动态发现机制。
4. 测试注册、查找、重复名称、未知名称、注销及重新注册，并验证注销不撤销已发布运行。

**完成条件：** 不依赖模型或真实 Agent，注册表的可见性与清理行为可由测试确认。

### 4. 实现启动路由与运行管理

1. 服务按名称定位 Provider，将请求交给它；启动期间保留必要的身份和管理信息，避免并发运行发生标识冲突。运行标识的生成者、唯一范围和释放时机在实现前明确，并以测试验证。
2. 区分启动失败与发布后的任务结算：启动拒绝不产生已发布句柄；启动成功后立即返回句柄，不等待任务完成。模拟 Provider 用可控 Promise 证明这两个时间点。
3. 跟踪本步骤需要的活动运行，约定结果结算、显式释放和服务关闭时的移除与资源所有权；不得让一次运行的失败或取消影响其他运行。
4. 验证正常结果、任务失败、启动失败、取消、重复释放和两个并发运行。测试应覆盖实际异步交错，例如启动尚未完成时取消或关闭，并确认没有遗留未处理的 Promise 拒绝。

**完成条件：** 模拟任务可从启动走到结果和清理；每条失败路径都有明确结果与资源归属。父子关系校验、数量和深度限制按第三阶段后续步骤完善，本步骤不假装已经实现。

### 5. 装配 Cordis 与端到端验证

1. 实现服务插件与 Context 类型声明，在所属作用域提供服务并注册释放逻辑；按项目实际插件注册流程接入，确认关闭服务时等待所拥有的异步清理。
2. 在测试中通过 Cordis Context 装配核心服务，注册模拟 Provider，提交一个任务，检查请求原样到达、启动句柄先返回、结果随后结算，并释放句柄与 Context。
3. 验证插件卸载后注册不可用、已接受运行的所有权与第 3、4 步约定一致；覆盖启动失败以及关闭与启动交错的清理路径。
4. 同步核心包 README、Agent 包说明、根目录结构及必要的构建配置，并为本次跨模块设计添加 Agent Note。运行受影响的聚焦测试、类型检查、构建及 `git diff --check`；命令以实现完成后的实际脚本为准。

**完成条件：** 通过真实 Cordis 装配完成一次模拟委派，测试显示启动、结果与清理的顺序；文档能让后续 Driver 和 Provider 的开发者找到公开入口与资源契约。

## 本步骤交付与限制

交付核心服务包、模拟 Provider 行为测试、Cordis 集成测试和必要的接口文档。模拟结果只证明服务路由和生命周期契约，不证明父 Agent 会自主委派，也不证明真实子 Agent、结果通知或会话隔离已经可用。完成后整理实际运行的检查与未覆盖范围，等待用户指示。
