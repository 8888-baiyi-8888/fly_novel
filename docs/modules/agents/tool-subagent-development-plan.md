# Tool SubAgent 详细开发计划

本文细化[第三阶段 Tool SubAgent](../../workflows/word-initialization/world-initialization-stage-3-plan.md#4-tool-subagent)，指导学习、设计和逐步实现父 Agent 的委派工具。本文是开发计划，示意名称和流程不代表现有可运行接口。每步完成后等待用户指示；完成本计划后不自动进入 Fork 开发。

## 一、要解决的问题

当前可信代码可以直接调用 SubAgent 服务，通过 Spawn 创建独立子 Agent；父 Agent 的模型还没有委派工具。本阶段让父 Agent 在已有工具执行机制中调用委派能力，先建立两类工具：

| 工具 | 模型需要提供 | 内部选择 | 预期行为 |
| --- | --- | --- | --- |
| 通用委派工具 | 任务说明；无需角色 ID 等特定业务参数 | 通用子 Agent 的 Preset，具体来源在设计步骤确定 | 创建全新会话的通用子 Agent，执行给定任务并交付结果。 |
| 角色委派工具 | 任务说明、必填角色 ID | `character-agent` | 创建角色子 Agent，并将本次角色 ID 交给明确的消费者；角色资料读取不因提供 ID 而自动存在。 |

工具名称、字段名和输出结构在设计步骤确定。角色 ID 是业务对象标识，与 Agent 实例 ID、运行 ID 及 Preset ID 不同。工具按父 Agent 职责装配，一类工具可以服务多个角色，每次调用按需创建实例；不为具体角色预建工具或 Agent。

工具按职责分开：`src/agents/plugins/subagent/tool-subagent/` 只提供通用委派工具与确需共用的委派能力；角色专用工具属于 [`src/tools/`](../../../src/tools/README.md) 下的具体业务工具，通过可信应用或适当的作用域装配机制注册。两者都复用 SubAgent 服务、Spawn 和 Driver；不在通用包中注册或实现角色专用工具。具体文件路径、必要的共享接口和依赖方向在实现时核实，避免 Agent 包反向依赖应用层工具。

## 二、官方参考与项目现状

固定参考 DeepSeek Harness commit [`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`](https://github.com/deepseek-ai/deepseek-harness/tree/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent)。从官方 [Tool SubAgent 说明](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/tool-subagent/README.zh.md)及[实现](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/tool-subagent/src/index.ts)追踪工具注册、一次性启动、结果与释放。该版本前台模式等待 `run.result` 并释放运行；也有依赖其他组件的后台和可继续模式。本项目不能据此声称已经具备后台任务、持续会话或完成通知。

| 项目能力 | 当前事实 | 本阶段要解决的问题 |
| --- | --- | --- |
| Tools | [工具服务](../../../src/agents/plugins/tools/README.md)按 Agent 作用域注册工具、校验和执行调用；批次串行执行，执行上下文有 signal 与身份快照。 | 在父 Agent 的 Tools 服务注册两类工具；厘清作用域注销、依赖缺失和重复名称。 |
| 父 Agent 上下文 | [工具执行契约](../../../src/agents/plugins/tools/contracts.ts)中的 `agent` 是可选身份快照，不是完整 Agent；[核心服务请求](../../../src/agents/plugins/subagent/subagent/types.ts)需要父 Agent 的最小身份视图。 | 确定由可信装配如何提供父身份及同一作用域的 SubAgent 服务；身份值不等同于授权凭证。 |
| Spawn | [Spawn Provider](../../../src/agents/plugins/subagent/subagent-spawn-in-process/README.md)要求 `presetId`，使用可信创建函数及共享 Driver；返回的 Run 需要调用方释放。 | 工具内部指定 Preset，传递取消信号；确定执行期间和结果交付后的资源所有权。 |
| 通用类型 | [bootstrap](../../../src/agents/core/bootstrap.ts)注册现有业务 Preset；不能假设已有可直接使用的通用子 Agent。 | 核对现有 `AgentRole`、Preset 和插件依赖，确定能实际运行的通用 Preset 及可信配置。 |
| 角色参数 | 请求没有每次委派的业务参数；[创建函数](../../../src/agents/runtime/subagent-in-process-creator.ts)不会接收角色 ID，[角色提示词插件](../../../src/agents/character/plugins/system-prompt/plugin.ts)也不读取它。 | 设计角色 ID 的校验、跨层传递和消费；明确角色数据加载不属于当前已实现能力。 |
| 父子结果 | 核心 Run 区分启动交付与最终结果；工具执行结果会返回父 Agent Loop。 | 选择首版结果交付方式，避免只返回运行 ID 后无人等待或释放。 |

## 三、首版设计方向

首版建议使用**前台一次性委派**：工具调用 `subagents.start()` 取得 Run 后等待 `result`，将终态转换为工具结果，并在结束前等待 `dispose()`。启动前失败不产生 Run；Run 交付后由工具持有并负责释放。结果读取和清理同时失败时须保留两个原因；取消信号从工具执行上下文传到启动与运行。具体输出格式、取消映射和错误报告在第 2 步确定，并根据现有 Tools 服务的实际错误转换验证。此方向不要求实现后台运行、状态查询、异步通知或持续对话。

工具描述应告诉父模型 Spawn 子 Agent 不自动看到父会话，任务说明须提供完成任务所需上下文。工具不得在用户输入或委派任务前后隐式拼接额外提示词；若未来确需提供角色上下文，应由明确设计的参数消费或资料访问机制负责，不把 ID 自行伪装为已加载角色资料。

模型只能提供该工具公开的业务输入。模型适配器、插件配置、授权目录、可委派范围及 Preset 与 Provider 的绑定由可信装配决定。每类工具只暴露实际需要的参数，缺少角色 ID 或 ID 格式不合法时在能判断的最早阶段拒绝；角色是否真实存在或有权使用，只有在明确资料来源与授权规则后才能验证，不凭格式校验声称已验证存在性。

## 四、详细开发步骤

每步开始时说明要解决的问题、调用方式、输入输出与预期行为；完成后记录实际结果并等待用户指示，不自动进入下一步。

### 1. 追踪官方工具与项目调用链

1. 从固定 commit 的官方插件 `apply`、工具注册、参数解析、`subagents.start()`、前台结果结算及 `dispose()` 追踪一次委派。区分一次性前台、一次性后台和可继续模式的依赖与返回结果；按源码记录观察，不把源码推断称作真实模型运行。
2. 对照项目的 [Tools 定义与执行](../../../src/agents/plugins/tools/contracts.ts)、工具注册、Agent Loop、SubAgent 服务、Spawn 和现有集成测试，画出一次模型工具调用的输入、执行、结果与取消链。
3. 核对工具执行上下文能否提供完整父 Agent、哪个作用域持有 SubAgent 服务，以及现有信号如何传播。列出模型工具与可信代码直接调用之间的差异，不假设父身份就是授权。
4. 核对角色 ID、通用 Preset、结果通知和后台任务的项目现状；明确尚缺能力及不能声称的行为。

**完成条件：** 文档记录官方固定版本调用链、项目现状、拟复用组件与缺口；完成学习与必要只读验证，不提前实现工具。

#### 官方调用链：固定版本源码

本步核对的官方仓库 commit 是 `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`。以下是[官方工具实现](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/subagent/tool-subagent/src/index.ts)的源码行为，不是本项目的真实模型运行日志。

```text
工具插件安装 → 按配置查找指定 Provider → defineTool → ctx.tools.register
  → 模型工具调用：description、prompt 等 → 工具执行，取得 exec.agent 与 exec.signal
  → ctx.subagents.start(provider, request) → 返回 Run
  → 前台等待 Run.result → 处理终态 → 等待 Run.dispose()
  → 工具结果返回父 Agent
```

工具实例对应配置的 Provider 和工具名，官方实现监听 Provider 增加、移除事件；Provider 出现时注册，移除时注销工具。前台执行从 `exec.agent` 获取父 Agent，并把 `exec.signal` 传入启动请求。结果为非完成终态时映射为工具错误；如果收集结果和释放均失败，保留两个错误。`description` 用于展示标签，`prompt` 作为子 Agent 任务内容；官方根据 Provider 的上下文继承语义调整工具描述。

官方另有一次性后台模式和可继续模式：一次性后台交给 jobs，返回 job ID；可继续模式调用 `startContinuable()`，在接受任务后返回子 Agent ID，由对应服务处理后续运行与通知。这些依赖与返回值不同于前台等待结果，不能仅凭现有 Run 推断本项目已经支持。官方允许按配置和 Provider 能力提供额外选项；本项目用户要求的通用和角色专用工具及角色 ID 参数是本项目方案，不能当成官方现成的对应功能。

#### 本项目的现有调用链

当前已有的**模型工具链**，以 [Agent Loop](../../../src/agents/plugins/loop/agent-loop-runtime.ts) 和 [ToolsService](../../../src/agents/plugins/tools/tools-service.ts)为依据：

```text
父 Agent.run({ prompt }) → Agent Loop 将已注册工具 Schema 提供给模型
  → 模型返回工具调用 → ToolsService 解析 JSON、校验并执行工具
  → 工具接收 callId、身份快照、workingDirectory 和 signal
  → 工具结果关联 callId，记录进父 Session → Agent Loop 继续模型请求
```

Tools 服务逐项串行执行同一批次，普通工具异常转换为错误结果。Loop 有可见工具时要求可信配置 `workingDirectory`；这个目录不是由模型作为工具参数指定。输入和输出经过工具服务的 JSON 快照和 Schema 处理，工具执行后的中止也会被检查。

当前已有的**可信代码 Spawn 链**，以[公开入口集成测试](../../../src/agents/tests/subagent-spawn-public-integration.test.ts)为依据：

```text
可信代码 → 父 Agent Context 中的 subagents.start('spawn', request)
  → SubagentRuntime 查找 Provider，合并请求取消与服务关闭信号
  → Spawn 检查 presetId → Driver 调用可信创建函数
  → Manager / Factory 创建子 Agent → Driver 提交原始任务并返回 Run
  → 调用方等待 result → 调用方 dispose → 同一 Manager 清理子 Agent
```

这两条链尚未由正式 Tool SubAgent 连接。可信代码能在启动后立即获得 Run，`result` 可能尚未完成；该句柄交付后的释放由接收方负责。SubAgent 服务关闭会处理尚未交付的启动，不会自动释放已经交付给调用方的 Run。

#### 父身份、作用域与取消

[工具上下文](../../../src/agents/plugins/tools/contracts.ts)的 `agent` 是可选的 `id`、`name`、`role` 身份快照；Harness [工具插件](../../../src/agents/plugins/tools/plugin.ts)从当前 Agent 作用域获取身份。它不是完整 Agent handle，也不提供其 Session、模型适配器或所有配置。独立创建 ToolsService 时身份可以不存在。[SubagentParent](../../../src/agents/plugins/subagent/subagent/types.ts)目前仅要求 `info.identity.id` 的结构视图，不能因此推断这个值已被认证或授权。

Agent Factory 为实例提供的插件服务建立隔离作用域；在同一父 Agent 装配 `tools`、`subagent` 和 Spawn 后，两个服务属于该实例的作用域。项目 SubAgent 注册表目前提供注册、查找和注销，**没有官方工具使用的 Provider 增删事件机制**；工具如何取得同一作用域的服务、验证依赖以及在 Provider 移除时如何表现，留给第 2 步设计，不假设自动镜像官方生命周期。

现有 Loop 将执行信号交给 ToolsService，再传给工具执行上下文；现有 SubAgent 服务会将传入 signal 与自身关闭信号组合，Driver 在创建和运行阶段处理取消。未来委派工具仍需将工具执行 signal 显式传给 `subagents.start()`，并对已交付 Run 负责；这条**跨工具与 SubAgent 的组合链尚未实现或验证**。

#### 当前能力边界与实测

- 当前 `SubagentStartRequest` 没有角色 ID 字段；角色 Preset 和提示词插件也不会因为选择 `character-agent` 而自动读取角色资料。普通 Agent Factory 的 `parameters` 会合并到 `Agent.info.parameters`，但现有 Spawn 创建函数未传入每次业务参数；能否供插件初始化读取仍需设计。
- [bootstrap](../../../src/agents/core/bootstrap.ts)注册角色、导演、写作和世界初始化主 Agent 等现有 Preset；[AgentRole](../../../src/agents/core/contracts/agent.ts)也是现有角色联合类型。当前没有核实到独立通用子 Agent Preset，第 2 步须确定其合理的类型与装配，不冒用业务 Preset。
- 当前没有正式的通用 / 角色委派工具、Tool SubAgent 的后台任务或子任务自动完成通知；也没有仅由角色 ID 自动完成资料绑定的调用链。本步未执行真实模型或官方工具调用。
- 已运行 `pnpm run build:tests`，再运行 `node --test .test-dist/agents/tests/agent-loop-tools.test.js .test-dist/agents/tests/subagent-spawn-public-integration.test.js`：6 项通过，1 项真实 DeepSeek 模型测试跳过。前者验证固定替身驱动的工具调用与结果回到父 Loop 等行为；后者验证可信代码调用正式 Spawn 的句柄、结果和清理。这是**两条分别测试的链路**，不表示父模型调用委派工具的完整链已经跑通。

下一步需要确定通用 Preset、角色 ID 的跨层消费、工具依赖和前台结果映射；本步不实现这些方案。

### 2. 确定两类工具的契约与装配方案

1. 为通用工具与角色工具分别确定名称、描述、必填任务和角色 ID 的 Schema、输出及错误；验证同一类型工具可对不同业务对象调用。明确通用工具不需要角色 ID，角色工具不让模型填写内部 `presetId`。
2. 解决通用 Preset：核对现有业务 Preset 与 `AgentRole` 的约束，比较复用现有通用能力与新增最小通用 Preset / 必要角色类型；确定系统提示词、Loop、Session、LLM 装配及配置来源。不得把角色或导演 Preset 仅换名称就称为通用，也不提前扩展无关业务。
3. 选择角色 ID 的数据契约：确定合法格式、谁负责校验、怎样从工具穿过核心请求、Provider、Driver 与创建方、哪个子实例消费者读取，以及数据是否进入模型请求。若复用 Agent 创建 `parameters`，核实其只进入 `Agent.info` 的实际限制；需要初始化期读取时先设计可用的实例作用域接口。不能仅接收 ID 后丢弃，也不能虚称已查询角色档案。
4. 明确角色参数缺省、无效、未知或未获允许时的拒绝时机；如果当前没有角色存储或授权来源，明确只验证可判断的格式与传递，不虚构存在性检查。通过两个不同角色 ID 验证不同实例收到正确数据。
5. 确定工具所需服务、可信父身份如何绑定至工具所属 Agent，以及 Provider、Preset、模型和权限从哪里配置；模型不控制这些内部设置。检查包依赖方向与现有公开扩展点，避免循环依赖或绕过工具作用域。
6. 确定前台结果映射：成功输出、`error`、`aborted`、启动拒绝、基础设施异常和清理失败各如何呈现；同时定义取消传播及始终释放 Run 的顺序，禁止把启动成功当作任务完成。
7. 确定父 Agent 按职责选择装配工具的方式；列出对核心请求、可信创建方、Preset、README、测试及必要架构文档的影响。工具描述和 Schema 应让模型知道 Spawn 无父会话历史，但不篡改任务原文。

**完成条件：** 记录两类工具输入输出、通用 Preset 方案、角色 ID 实际消费路径、依赖和资源归属、失败与取消行为、验证用例；方案明确后再实施，不在本步开发 Fork、角色档案或后台通知。

#### 第 2 步设计结果

以下保留两类工具的设计方向，字段、服务和工具尚未实现。通用部分先按第 3、4 步建立；角色 ID 的具体消费方式和必要接口在第 5 步结合实际角色能力重新确定。两个工具都由可信装配选择并注册，模型不传内部 `presetId`、Provider 或插件配置。

| 工具名称 | 模型输入 | 内部 Preset | 成功结果 |
| --- | --- | --- | --- |
| `delegate` | 必填 `task`：非空任务文字 | `generic-subagent` | 等待子任务完成后，返回其文本输出。 |
| `delegate_character` | 必填 `task` 和 `characterId`：均为非空字符串；角色 ID 不允许首尾空白 | `character-agent` | 在角色子实例接收该 ID 后执行任务，等待完成并返回文本输出。 |

两者的工具描述说明子 Agent 不继承父会话，调用方要在 `task` 中提供必要背景。任务文字仅检查非空，保留原文，不追加提示词；角色 ID 是独立数据，不通过修改任务文字传递。缺少字段、类型不符、空白角色 ID、首尾空白角色 ID 或多余字段按工具 Schema / 入口校验拒绝，不创建子实例。当前没有可用于确认角色存在或授权的角色资料服务：合法格式的 ID 不代表真实角色存在、已获授权或已加载资料。角色 ID 不自动作为世界事实写入。

**通用子 Agent：** 第 2 步建议以独立的 `generic-subagent` Preset 实现，装配标准 `agent-loop-runtime`、`system-prompt`、`llm` 和 `session`，提供简洁的通用任务职责提示词，不把角色或导演 Agent 当作通用 Agent。是否需要给 `AgentRole` 增加 `subagent` 值，在第 3 步核对实际创建契约、使用点及持久化影响后确定；不能仅为符合示意命名扩大改动。子 Agent 的 provider、model 和适配器由可信应用显式提供。

**角色 ID 的链路：** 角色工具需要接收并传递 `characterId`，但目前尚无已确定的角色资料来源及实际消费链。第 5 步先核对角色 Agent 现有能力，确定 ID 应由哪个实际组件使用及如何影响角色任务，再决定是否需要调整 SubAgent 请求、创建参数或作用域接口。通用子 Agent 和通用委派工具不因角色需求预先增加这些接口。

**如何证明 ID 生效：** 测试须观察角色任务的实际消费者如何使用 ID，以及它对任务输入或执行产生什么影响；仅验证某个新服务保存了 ID，不足以证明角色 Agent 已按该角色工作。若资料来源或权限尚不可用，应如实标明限制，不伪造角色档案或把保存 ID 写成已完成角色绑定。

**父作用域与注册：** 在 `src/agents/plugins/subagent/tool-subagent/` 建立工作区包，提供通用委派工具及其作用域注册；角色专用工具在 `src/tools/` 下定义，由可信应用或单独的作用域装配入口注册，不由通用包直接依赖或注册。两类工具可以分别装配；共享执行能力以公开接口复用，具体依赖和构建边界在第 4 步核实。装配时从同一可信作用域取得 `tools`、`subagents` 服务和 `agent` 身份，构造核心请求需要的最小父身份视图；不根据模型输入的 ID 查找或冒充父 Agent。模型输入不含父身份。工具的 Provider 固定为可信装配选定的 `spawn`，对应 Preset 与模型配置由可信应用负责；实例作用域之外不能使用该身份值推断授权。

当前核心没有 Provider 变更事件：安装时明确检查 `spawn` 存在，缺失则初始化失败；执行时再次通过当前作用域的服务启动，若 Provider 已注销则返回启动失败，不能声称工具会自动随 Provider 动态注销。工具注册者负责作用域注销：插件使用 Cordis Effect，应用装配使用对应的注册清理函数及 Agent 生命周期；同一个父 Agent 的同名注册冲突必须明确报错。检查缺失依赖与激活顺序时，以实际装配测试为准。

**输出、取消与所有权：** 工具只在 `stopReason: 'completed'` 时把输出作为成功文本交给 ToolsService；`error`、`aborted` 和基础设施异常转为可区分的失败，不把部分输出当成成功。启动拒绝时没有已交付 Run；一旦 `start()` 返回 Run，工具等待 `result`，无论成功或异常均等待 `dispose()`，最后才结束调用。执行 signal 原样交给服务，由核心组合服务关闭信号；工具注销不私自丢弃进行中的已交付句柄。结果和清理同时失败时内部保留两个原因，并返回不泄露敏感数据的错误说明。现有 ToolsService 会将异常投影成模型可见的错误文本与代码，不会自动展示 `AggregateError.errors`；第 6 步既检查内部错误保留，也验证对模型投影不会掩盖清理失败。取消时 ToolsService 还会按现有逻辑将已中止调用归为取消，需验证实际可观察结果。

**实现顺序与验证：** 第 3 步先建立通用子 Agent，第 4 步建立并验证通用委派工具，第 5 步再设计并建立角色专用工具及确有消费者的角色参数链路，最后验证生命周期和整体集成。各步只修改完成该步所需的接口，不提前开发后续能力；类型检查和构建在对应实现步骤执行。

### 3. 建立通用子 Agent

**问题与使用方式：** 建立一个可由可信代码通过已有 Spawn 创建的通用 Agent，先确认它怎样接收任务并返回结果。输入是任务原文、可信提供的模型配置和取消信号；输出是运行句柄及最终任务结果。

1. 对照已有 Preset、Factory、Manager、Loop 和 SystemPrompt，确认通用 Agent 的职责、Preset、提示词、角色标识和最小插件装配。检查 `AgentRole` 及相关持久化使用，再决定必要的类型变更；不将角色或导演 Preset 改名当作通用 Agent。
2. 实现通用 Agent 的最小 Preset 与必要提示词，使用可信应用提供的模型路由和适配器；通过现有注册入口使其可由 Spawn 选择，不预建固定数量实例。
3. 由可信代码直接调用正式 Spawn，以固定模型替身验证任务原文、返回结果、独立 Agent / Session、父历史隔离和运行释放；覆盖配置缺失、创建失败和取消的相关路径。
4. 同步该 Agent 的说明、目录登记及必要 Agent Note。此步不增加角色 ID、角色绑定组件或模型委派工具。

**完成条件：** 通用子 Agent 在现有 Spawn 链路中可创建、执行和清理；清楚说明其职责、配置和尚不具备的能力。完成后等待用户指示。

### 4. 建立通用 SubAgent 委派工具

**问题与使用方式：** 让父 Agent 的模型通过工具委派一个通用任务。模型输入任务说明；可信装配确定 Provider、通用 Preset 和运行配置；首版等待最终结果再返回。

1. 在 `src/agents/plugins/subagent/tool-subagent/` 建立通用工具包，沿 `defineTool`、Tools 服务和 Cordis 作用域注册；核对公开入口、工作区依赖、注销方式以及所需服务的激活顺序。
2. 定义通用工具 Schema 和描述：接收任务原文，不要求角色 ID；工具内部选择第 3 步的通用 Preset，提醒模型子 Agent 不继承父会话，不擅自拼接提示词。
3. 使用同一父 Agent 作用域的 SubAgent 服务和可信身份发起 Spawn，将工具 signal 传给启动；工具持有已交付 Run，等待结果并释放。按设计处理启动失败、任务错误、取消及清理失败。
4. 先通过正式工具注册与执行测试闭环，再用固定模型替身驱动父 Agent Loop，验证工具调用、子 Agent 返回和父 Agent 后续响应；检查作用域隔离及缺失依赖、重复名称的错误。
5. 更新通用工具包说明与必要的工作区、Agent 文档和 Agent Note；不在本包实现角色专用工具。

**完成条件：** 模型可以通过正式通用工具委派任务给第 3 步的通用子 Agent，结果返回父 Agent 并完成清理。完成后等待用户指示。

### 5. 设计并建立角色专用委派工具

**问题与使用方式：** 角色工具需要任务说明和角色 ID，并使用现有 `character-agent`。在实现前先确定 ID 怎样被角色任务实际使用；角色工具属于 `src/tools/`，共用已有 SubAgent 底层。

1. 核查当前角色 Agent 的输入、提示词和可用资料来源，确定 `characterId` 对应什么业务对象、在哪里校验、由谁使用，以及它怎样影响角色任务。区别“传递 ID”“获取角色资料”和“模型按角色资料工作”；记录尚未实现的能力。
2. 根据实际消费需求选择最小传递方式，再确定是否需要修改 SubAgent 请求、Driver、Factory 或角色 Agent；区分业务输入与可信插件配置，避免只为保存 ID 新增没有实际消费者的服务。必要的接口变更、验证和资源归属在实施前写入本计划。
3. 在 `src/tools/` 实现角色专用委派工具，接收任务和必填角色 ID，内部选择 `character-agent`；由可信装配将它注册给需要的父 Agent。对缺失、格式无效和不能确定存在性的输入，按已确定的契约处理，不虚构角色数据或授权。
4. 用至少两个不同角色 ID 验证**实际消费者**如何使用各自的数据及其对角色任务的影响，同时检查隔离、任务原文、错误、取消与释放。如果目前没有必要的角色资料来源，先清楚说明阻塞和可验证范围，不把 ID 保存成功当成完整角色委派。
5. 同步角色工具及受影响模块说明、注册入口、测试和必要的 Agent Note；不改变通用包只提供通用工具的职责。

**完成条件：** 角色工具的 ID 有明确、经验证的实际消费路径，父 Agent 能调用角色工具并取得结果；角色资料与权限尚未具备时明确其限制。完成后等待用户指示。

### 6. 生命周期与错误路径验证

1. 使用受控门闩验证启动前取消、创建中取消、运行中取消、工具卸载或父 Agent 关闭；无需依赖任意等待时间。确认未交付运行的回滚和已交付 Run 的持有者。
2. 验证任务成功、运行错误、取消、基础设施异常和 `dispose()` 失败；结果收集和清理同时失败时不能吞掉任一原因。确认不把错误、取消或部分输出伪装为成功结果。
3. 验证多个独立调用的参数、运行 ID、Agent 和 Session 互不干扰；按现有 Tools 批次串行执行语义设计测试，不声称同一工具批次天然并行。
4. 检查父 Agent 关闭、工具卸载及重复清理的交错，使用真实 Manager 核对不遗留子实例；需要变更生命周期时先更新相关设计与测试。

**完成条件：** 成功、失败、取消和清理均有确定的可观察结果；没有未持有者管理的 Run 或已交付句柄泄漏。

### 7. 父 Agent 模型调用与交付验证

1. 使用固定模型适配器驱动真实父 Agent Loop：模型在工具调用中分别选择通用工具和角色工具；验证 Schema 对应、角色 ID 和任务到达正确消费者、工具结果进入父会话并可被后续模型步骤使用。
2. 验证两类工具仅在装配了对应插件 / 工具的父 Agent 中可见，未提供角色 ID 或格式错误时不会启动子 Agent；验证父、子 Session 隔离，以及不同工具选择的 Preset 正确。
3. 覆盖启动回执与完成结果的区分、错误和取消传播、Provider 注销或缺失、运行释放；用公开包入口和显式构建前置条件，不使用测试 Provider 冒充正式 Spawn。
4. 同步工具包 README、Agent 包说明、工作区结构、必要的接口文档和 Agent Note。对通用 Preset、角色 ID 消费以及运行限制只写实际实现；父 Agent 获得子 Agent 建议不代表世界事实已被用户确认。
5. 运行受影响的聚焦测试、类型检查、必要构建和文档链接与空白检查；固定替身测试不声称真实模型调用。若另行执行真实模型冒烟，使用已有可信配置，不记录密钥，报告是否实际执行及限制。

**完成条件：** 父 Agent 的模型可以在已装配工具范围内发起通用或角色委派，并在前台获得可区分终态的结果；角色 ID 到达明确消费者，所有运行可正确清理。完成后等待用户指示，再考虑 Fork 或其他能力。

## 五、交付边界

本计划交付通用和角色两类工具及其必要的创建输入，通用包不承载角色专用工具。后台任务、自动异步通知、可继续子 Agent、模型自行配置适配器、角色档案或世界资料存取、用户确认流程及 Fork 不属于本计划；是否支持和如何实现由后续任务确定。
