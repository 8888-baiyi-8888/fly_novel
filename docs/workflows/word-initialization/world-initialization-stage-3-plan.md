# 世界初始化第三阶段：DeepSeek Harness 子 Agent 委派机制

本文是世界初始化开发计划中子 Agent 委派机制的具体学习计划。

## 一、学习目标

通过实际运行 DeepSeek Harness 的 SubAgent 示例，阅读源码、追踪调用链、编写验证程序，理解一套完整的子 Agent 委派机制。

本阶段不直接照搬官方实现，而是先理解每个组件为什么存在、如何协作，以及它解决了什么问题。

最终需要能够独立实现一个简化版子 Agent 委派机制，并将其与当前项目的 Harness 架构进行对照。

## 二、学习环境与约定

官方项目：

https://github.com/deepseek-ai/deepseek-harness

学习要求：

1. 首先记录学习时官方仓库的 commit SHA，避免 master 更新造成源码对不上。
2. 优先使用官方测试、示例和实际运行结果理解行为。
3. 阅读源码时，从调用入口向下追踪，不以单纯阅读类和接口定义为主。
4. 每个学习步骤都要有实际操作和验证结果。
5. 每一步完成后，整理本步调用链、关键代码和个人理解，等待确认后再继续。

## 三、具体学习步骤

### 第一步：运行官方 SubAgent，观察真实委派过程

**目标：** 先不阅读大量源码，实际观察一次子 Agent 委派是如何发生的。

**操作：**

1. 阅读官方 SubAgent 包组说明。
2. 找到官方最小进程内子 Agent 配置。
3. 搭建或运行一个最小示例，组合以下三个组件：
   - dsh-subagent
   - dsh-subagent-spawn-in-process
   - dsh-tool-subagent
4. 配置一个父 Agent，让其拥有 subagent 工具。
5. 向父 Agent 输入一个需要独立分析的任务，观察子 Agent 是否被创建。

**测试任务：**

父 Agent 接到任务：

「分析下面这段世界设定是否存在逻辑矛盾，并给出修改建议。」

要求父 Agent 自主决定是否委派，而不是直接由程序调用子 Agent。

**观察内容：**

- 父 Agent 如何知道自己拥有 subagent 工具？
- 工具调用时传入了什么参数？
- 子 Agent 是否立即开始运行？
- 父 Agent 得到了什么返回值？
- 子 Agent 完成后，父 Agent 如何获得结果？
- 父子 Agent 的运行过程是否相互独立？

**本步产出：** 一份实际运行记录，包含调用日志、执行顺序和父子 Agent 的交互过程。

### 第二步：追踪委派工具的实现

**目标：** 搞清楚模型生成工具调用后，程序究竟执行了什么。

**源码入口：**

https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/tool-subagent

重点阅读：

- src/index.ts
- README.md

**操作：**

1. 找到 subagent 工具的定义。
2. 找到工具注册到 ctx.tools 的位置。
3. 找到工具的实际执行函数。
4. 从执行函数开始追踪其调用的服务接口。
5. 对照第一步的运行日志，找到对应代码。

**重点验证：**

- 工具参数 Schema 如何定义？
- 工具如何获得 provider 配置？
- 工具如何调用 ctx.subagents？
- 工具为什么不直接创建 Agent？
- 工具返回的启动回执是什么？
- 为什么工具返回后，子 Agent 还可能继续运行？

**本步产出：** 画出工具从模型调用到子 Agent 服务的真实调用链，并标注关键函数。

### 第三步：追踪 SubAgent 服务的实现

**目标：** 搞清楚子 Agent 服务究竟负责什么，以及它如何管理一次委派。

**源码入口：**

https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent

重点阅读顺序：

1. src/types.ts
2. src/index.ts
3. src/manager.ts
4. src/activation.ts

**操作：**

1. 先看 types.ts，找到启动请求、Provider、Run、Activation 等核心类型。
2. 阅读 index.ts，找到服务注册、Provider 注册和启动入口。
3. 从 startActivation() 开始追踪。
4. 进入 manager.ts，观察服务如何管理一次启动。
5. 进入 activation.ts，观察任务执行记录和生命周期管理。

**重点验证：**

- Provider 如何注册和查找？
- 一次委派请求包含哪些信息？
- startActivation() 返回的是什么？
- Manager 如何管理父子关系？
- Activation 如何持有实际运行句柄？
- 任务结果由谁保存和交付？
- 启动失败和执行失败如何区分？

**本步产出：** 绘制 Service、Manager、Activation、Provider 的关系图，并记录一次启动的实际调用顺序。

### 第四步：追踪 Spawn Provider 如何创建子 Agent

**目标：** 搞清楚官方究竟如何利用现有 Agent 创建能力，创建一个独立运行的子 Agent。

**源码入口：**

https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-spawn-in-process

同时阅读共享运行驱动：

https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-in-process-driver

重点阅读：

- Provider 的 src/index.ts
- 共享 Driver 的 src/index.ts
- 与 Agent Factory、Session 有关的调用位置

**操作：**

1. 找到 Spawn Provider 注册的位置。
2. 找到 Provider 接收启动请求的函数。
3. 追踪它如何准备子 Agent 的创建参数。
4. 找到 Agent Factory 的调用位置。
5. 观察子 Agent 的 Session 如何创建。
6. 观察模型、工具、Preset 等运行配置如何继承或覆盖。
7. 追踪子 Agent 如何执行任务。
8. 找到子 Agent 输出的收集位置。
9. 追踪 Agent 和 Session 的清理过程。

**重点验证：**

- 子 Agent 是如何创建出来的？
- 为什么子 Agent 有独立 Session？
- Spawn 和普通 Agent 创建有什么区别？
- 子 Agent 是否继承父 Agent 的完整历史？
- 父 Agent 的模型、工具和 Preset 如何影响子 Agent？
- 子 Agent 执行完成后如何得到最终输出？
- 执行失败时是否仍然可以保证资源清理？

**本步产出：** 画出从 Provider 到 Agent Factory，再到子 Agent 执行与销毁的完整流程图。

### 第五步：实际追踪结果返回父 Agent 的过程

**目标：** 搞清楚子 Agent 完成后，结果如何重新进入父 Agent 的运行过程。

**源码入口：**

- subagent/src/manager.ts
- subagent/src/activation.ts
- subagent/src/continuation-messages.ts
- tool-subagent/src/index.ts

**操作：**

1. 找到子 Agent 执行完成的位置。
2. 找到结果被 Manager 接收的位置。
3. 找到 Activation 的结束处理。
4. 找到完成通知的生成位置。
5. 找到通知进入父 Agent Session 的位置。
6. 追踪父 Agent 如何继续运行并使用结果。

**实际测试：**

分别验证：

- 子 Agent 正常完成。
- 子 Agent 执行失败。
- 子 Agent 返回空结果。
- 父 Agent 执行期间子 Agent 完成。
- 父 Agent 已经空闲时子 Agent 完成。

**重点区分：**

- 工具调用结果。
- 子 Agent 启动回执。
- 子 Agent 最终结果。
- 父 Agent 收到的完成通知。

**本步产出：** 两条完整的时间线：启动过程和结果交付过程。

### 第六步：研究 Fork、取消与资源管理

**目标：** 在理解 Spawn 的基础上，进一步理解官方如何处理不同的子 Agent 运行模式和异常生命周期。

**源码入口：**

- subagent-fork-in-process
- subagent-in-process-driver
- subagent/manager.ts
- subagent/activation.ts

**操作：**

1. 对比 Spawn 和 Fork 的创建流程。
2. 观察 Fork 如何使用父 Agent 已完成的会话历史。
3. 找到子 Agent 的取消入口。
4. 追踪取消信号如何传递。
5. 观察取消后如何等待资源释放。
6. 查看父 Agent 结束时如何处理仍在运行的子任务。
7. 查看最大委派深度和活跃子 Agent 数量限制。

**重点验证：**

- Spawn 和 Fork 的区别是什么？
- 子 Agent 的取消由谁负责？
- Agent Loop 如何响应取消？
- 如何防止 Agent 实例泄漏？
- 多个子 Agent 并行执行时如何管理？
- 父 Agent 与子 Agent 的资源归属是什么？

**本步产出：** 一份 Spawn/Fork 对比记录，以及正常结束、执行失败、主动取消三种情况下的资源管理流程图。

### 第七步：自己实现最小委派机制

**目标：** 不再依赖阅读理解，自己动手实现一次完整的子 Agent 委派。

在当前项目中，先复用已有的：

- Agent Factory
- Agent Manager
- Agent Loop
- Tools
- Session

**开发顺序：**

1. 定义最小的子 Agent 启动请求和执行结果。
2. 实现一个最简单的 SubAgent 服务，负责接收启动请求。
3. 实现一个 Spawn Provider，负责创建和运行子 Agent。
4. 将子 Agent 工具注册到父 Agent。
5. 让父 Agent 可以通过工具发起委派。
6. 实现启动回执和最终结果交付。
7. 实现基本的取消、异常处理和资源清理。

**最终验证：**

通过终端运行：

用户输入 → 父 Agent 分析 → 自主决定是否委派 → 创建子 Agent → 独立执行 → 结果交付父 Agent → 父 Agent 综合回答。

先使用固定模型替身验证整个执行流程，再使用真实模型验证自主委派行为。

本阶段不接入具体的世界初始化业务。

## 四、后续扩展学习

完成最小委派闭环后，再根据需要研究：

1. 外部子 Agent：ACP、Codex、Claude Code、DSH SDK。
2. 子 Agent 之间的消息传递。
3. 子 Agent 的持续会话与恢复。
4. 多级委派和并行任务管理。
5. 子 Agent 的 Preset、模型路由和工具权限隔离。

这些不属于第一版最小实现的前置条件。

## 五、学习成果

完成本阶段后，需要具备以下能力：

- 能从源码解释一次 SubAgent 委派的完整调用链。
- 能独立定位工具、服务、Provider、Manager、Activation 的职责。
- 能解释 Spawn 和 Fork 的实现区别。
- 能追踪任务结果、取消和资源清理。
- 能独立实现一个最小的子 Agent 委派闭环。
- 能结合现有 Harness 架构，判断哪些设计值得复用，哪些需要调整。

每一步完成后等待指示，不自动进入下一步。