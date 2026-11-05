# 世界初始化第三阶段：SubAgent 委派机制开发

本文是世界初始化开发计划中子 Agent 委派机制的具体开发计划。
遵从deepseek harness的开发样式，将其代码都存储在src\agents\plugins\subagent下，不要仿造现在的skill将其分开。

## 一、开发目标

参考 DeepSeek Harness 的 SubAgent 实现，独立开发一套完整的子 Agent 委派机制。

开发过程中优先尊重官方 Package 架构、模块职责和依赖关系，尽可能保持相同的组织方式与调用思路。

本项目已有 Agent Factory、Agent Manager 等基础设施，但尚未实现完整的子 Agent 委派能力。

本阶段不直接开发世界初始化所需的具体业务子 Agent，而是先完成通用 SubAgent 基础设施。

官方参考：

https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent

## 二、开发原则

1. 优先参考官方 Package 划分，不随意合并不同模块。
2. 优先复用现有 Agent Factory、Agent Manager、Agent Loop、Session 和 Tools。
3. 每个 Package 明确自身职责、输入输出和依赖关系。
4. 采用 Cordis 插件机制完成服务注册和模块装配。
5. 不预先设计尚未理解的接口，结合官方源码逐步确定。
6. 每个开发步骤都需要独立测试，确保模块可以正常工作。
7. 官方实现仅作为技术参考，不直接复制整个实现。

子 Agent 的创建方式与类型是两个维度：Spawn / Fork 决定会话如何初始化，可信装配决定允许选择哪些 Agent Preset 及其配置。主 Agent 可以根据任务选择允许的类型，不预建固定数量的子 Agent；具体选择契约和 Spawn 实施步骤见 [Spawn 开发计划](../../modules/agents/subagent-spawn-in-process-development-plan.md)。

## 三、开发顺序

### 1. SubAgent 核心服务

**官方参考：** `packages/subagent/subagent`

主要参考文件：
- src/index.ts
- src/manager.ts
- src/types.ts
- src/activation.ts

**开发目标：**

建立独立的 SubAgent 核心服务，作为委派机制的统一管理入口。

**开发内容：**

1. 研究官方 SubAgent Service 的注册与使用方式。
2. 定义 Provider 注册和查找机制。
3. 定义子任务启动请求与执行结果。
4. 实现 SubAgent Service。
5. 实现基础任务管理与标识管理。
6. 接入 Cordis 注册机制。
7. 在 Spawn 类型选择设计确定后，检查启动请求是否需要携带选择标识，并同步调整受影响的 Provider 与测试；保留现有启动、取消和清理契约。

**验证目标：**

能够通过 Cordis Context 注册 SubAgent 服务，并注册一个简单的模拟 Provider，完成一次模拟任务启动。

### 2. 进程内共享运行驱动

详细步骤见[进程内共享运行驱动开发计划](../../modules/agents/subagent-in-process-driver-development-plan.md)。

**官方参考：** `packages/subagent/subagent-in-process-driver`

**开发目标：**

建立进程内子 Agent 的公共运行逻辑，避免 Spawn 和 Fork 各自重复实现运行流程。

**开发内容：**

1. 阅读官方 Driver 的接口与实现。
2. 明确 Driver 与 SubAgent Service、Provider 的职责边界。
3. 设计公共运行参数和结果结构。
4. 实现进程内 Agent 的执行驱动。
5. 处理执行结果、异常和取消信号。

**验证目标：**

通过一个模拟 Agent 验证 Driver 能够执行任务、收集结果并处理失败。

### 3. Spawn In Process

详细步骤见 [Spawn In Process 开发计划](../../modules/agents/subagent-spawn-in-process-development-plan.md)。

**官方参考：** `packages/subagent/subagent-spawn-in-process`

**开发目标：**

实现真正的进程内子 Agent 创建能力。

**开发内容：**

1. 研究官方 Spawn Provider。
2. 实现 Provider 注册。
3. 通过现有 Agent Factory 创建子 Agent。
4. 为子 Agent 配置独立 Session。
5. 配置子 Agent 的模型、Preset 和工具。
6. 将任务说明和必要上下文传递给子 Agent。
7. 通过共享 Driver 执行子 Agent。
8. 管理子 Agent 实例的生命周期。
9. 支持可信调用方从允许的类型中为每次任务选择子 Agent，例如选择角色 Agent；相同类型的多次委派仍创建相互独立的实例。

**验证目标：**

通过父 Agent 委派任务，成功创建一个独立子 Agent，并完成实际任务。

### 4. Tool SubAgent

详细步骤见 [Tool SubAgent 开发计划](../../modules/agents/tool-subagent-development-plan.md)。

**官方参考：** `packages/subagent/tool-subagent`

**开发目标：**

让父 Agent 能够通过模型工具调用自主发起子 Agent 委派。按子 Agent 类型或委派能力封装专用工具，每个工具只暴露该能力需要的参数；不同工具复用同一套 SubAgent 服务和进程内运行机制。

工具对应 Agent 类型或委派能力，不对应预先创建的具体实例。父 Agent 按自身职责装配需要的工具；一次工具调用按需创建子 Agent，同一工具可以用于多个具体业务对象。

本阶段只设计和实现两类委派工具：

- **通用委派工具：** 接收任务说明，不要求角色 ID 等特定业务参数。其使用的通用子 Agent Preset 及可信配置来源需要在详细设计中确定；当前内置 Preset 不应被假定为已经提供通用子 Agent。
- **角色委派工具：** 接收任务说明和必填的角色 ID，工具内部选择 `character-agent`。角色 ID 是业务角色标识，不是每次创建出的 Agent ID 或运行 ID；ID 的校验、传递与消费方式需要在详细设计中确定。

这两类工具可以由父 Agent 根据职责选择装配，不预设固定数量的子 Agent。通用工具没有特定业务参数，但仍需任务说明；是否提供其他通用控制参数以实际工具设计为准。

通用委派工具放在 SubAgent 的 `tool-subagent` 包；角色专用工具放在 `src/tools/` 的具体工具目录。两者共用底层委派服务，分别由可信装配注册到需要它们的父 Agent。

**开发内容：**

1. 阅读官方委派工具的定义与执行过程。
2. 设计不同类型专用委派工具的定义和参数 Schema，明确必填、可选、无专属参数与错误处理；只要求模型填写它需要决定且能够确定的信息。
3. 各工具内部配置对应的子 Agent `presetId`，将工具参数转换为委派请求；模型不需要填写工具已经确定的类型。直接由可信程序调用 Spawn 时仍按其契约提供 `presetId`。
4. 设计每次委派业务参数的校验、传递和消费：明确参数由哪个类型的组件定义、谁校验、在哪里读取，以及是否需要提供给模型；现有请求和创建函数尚未提供这条完整链路。
5. 区分任务原文、每次委派业务参数和可信运行配置；模型不直接提供插件配置、模型适配器或授权目录。应用已知的上下文是否由程序补充，按具体工具确定。
6. 将父 Agent 所需的专用工具注册到该 Agent 的 Tools 服务；不同工具共用 SubAgent Service、Provider 和 Driver，不为具体业务对象预建固定数量的工具或 Agent。
7. 处理启动回执、启动失败及结果交付；明确已交付运行的取消和释放责任。
8. 配置允许使用的 Provider 和委派限制，核对不同父 Agent 的工具装配和作用域隔离。

**验证目标：**

父 Agent 能够通过模型生成的工具调用，分别发起通用任务和指定角色 ID 的角色任务；验证两类工具的参数、类型选择、缺失或无效角色 ID 的拒绝，以及底层执行和资源清理。实际角色资料如何绑定或读取须单独设计，不能仅凭传入角色标识声称已加载资料。

### 5. Fork In Process

详细步骤见 [Fork In Process 开发计划](../../modules/agents/subagent-fork-in-process-development-plan.md)。

**官方参考：** `packages/subagent/subagent-fork-in-process`

**开发目标：**

支持基于父 Agent 会话历史创建子 Agent，与 Spawn 形成不同的上下文继承方式。

**开发内容：**

1. 阅读官方 Fork Provider，分析 Fork 与 Spawn 的上下文差异。
2. 结合官方实现和项目实际契约，设计 Fork 的类型选择、历史继承及所选 Preset 的工具与历史兼容性；明确允许范围及失败行为。
3. 实现父会话历史的获取与传递。
4. 实现独立子 Agent 的会话初始化。
5. 通过共享 Driver 执行任务。

**验证目标：**

验证 Spawn 和 Fork 在上下文、会话历史和任务执行方面的区别。

### 6. Tool SubAgent Control

**官方参考：** `packages/subagent/tool-subagent-control`

**开发目标：**

实现父 Agent 对已启动子 Agent 的进一步控制。

**开发内容：**

1. 阅读官方控制工具的接口与实现。
2. 实现子任务状态查询。
3. 实现向子 Agent 发送消息。
4. 实现子 Agent 中断。
5. 实现任务标识与父子关系校验。
6. 处理控制请求的异常情况。

**验证目标：**

父 Agent 能够查询子任务状态、向子 Agent 发送消息，并根据需要中断任务。

### 7. 生命周期与并发管理完善

**官方参考：** SubAgent Service、Manager、Activation 及各 Provider。

**开发目标：**

完善整个委派系统的运行稳定性。

**开发内容：**

1. 完善父子 Agent 关系管理。
2. 实现委派深度限制。
3. 实现活跃子任务数量限制。
4. 实现任务取消与资源清理。
5. 处理父 Agent 关闭时的子任务收尾。
6. 处理启动失败、运行失败和取消等不同状态。
7. 检查并发执行时的资源竞争问题。

**验证目标：**

通过并发任务、失败任务、取消任务和父 Agent 关闭等测试，验证资源管理的正确性。

## 四、整体开发验证

完成上述模块后，进行一次完整的集成测试。

**测试流程：**

用户输入 → 父 Agent → 模型决定是否委派 → Tool SubAgent → SubAgent Service → Spawn Provider → Agent Factory → 子 Agent 执行 → 结果交付 → 父 Agent 继续执行 → 最终回答。

测试要求：

- 父 Agent 能自主决定是否委派。
- 可以同时启动多个子 Agent。
- 可按任务选择允许的子 Agent 类型，并验证无效或未授权选择会被拒绝。
- 每个子 Agent 有独立会话。
- 可以区分启动成功与任务完成。
- 父 Agent 能正确接收子 Agent 结果。
- 支持任务失败和取消。
- 能正确管理子 Agent 生命周期。

优先使用固定模型替身验证程序执行链路，再使用真实模型验证实际委派行为。

## 五、后续扩展

以下内容不属于第一版必须实现的范围：

- ACP 外部 Agent。
- Codex、Claude Code 等外部 Agent Provider。
- DSH SDK Provider。
- 多级子 Agent 委派。
- 更复杂的子 Agent 通信和持续会话机制。

## 六、阶段完成标准

完成一套独立、可运行、可测试的 SubAgent 委派基础设施。

能够从用户输入开始，完整追踪主 Agent 的决策、工具调用、子 Agent 创建、任务执行、结果交付和生命周期清理。

完成后等待指示，再进入世界初始化业务 Agent 的开发。
