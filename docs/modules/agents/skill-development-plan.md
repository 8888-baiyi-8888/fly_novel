# Agent Skill 相关工具开发计划

本文细化[世界初始化主 Agent 开发计划中的第 3 步](../../workflows/word-initialization/world-initialization-stage-2-plan.md#3-创建-skill-的相关工具)。目标是让 Agent 发现并按需加载获授权的 Skill，重点支持 Skill 与所属 Agent 绑定。本文是开发计划，具体接口先结合使用示例讨论确认；不表示相关能力已经实现。

## 要解决的问题

世界初始化主 Agent 需要在处理任务时获得适用的指导，但不应每次把所有 Skill 的全文放进系统提示词。Agent 先看到有权使用的 Skill 名称与用途，在需要时调用工具读取具体内容。

不同 Agent 拥有不同的职责。放在世界初始化主 Agent 目录中的专属 Skill，默认只能由获授权的世界初始化主 Agent 实例发现和加载；角色、导演等其他 Agent 不能因为处于同一个项目中就读取它。将来若有需要多个 Agent 使用的 Skill，再明确配置授权，不在本阶段预设全局共享规则。

## 官方实现与项目现状

以 DeepSeek Harness 固定提交 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3` 为参考：

| 官方能力 | 职责 | 参考 |
| --- | --- | --- |
| Skill 服务 | 管理提供方，汇总 Skill 信息，并通过提供方加载内容 | [dsh-skill](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/skill/README.md) |
| 文件系统提供方 | 从文件系统发现 Skill，解析元信息并按需读取内容 | [dsh-skill-filesystem](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/skill-filesystem/README.md) |
| Skill 工具 | 向模型提供可用 Skill 目录，并提供按名称加载完整内容的工具 | [dsh-tool-skill](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/tool-skill/README.md) |

开发时对照官方的职责和真实接口，结合本项目已有能力逐步实现；官方的全部提供方、目录优先级、文件监听、会话目录更新和显式命令调用不自动纳入第一版。具体参考文件、差异和固定上游版本应随实现记录。

本项目已有按 Agent 实例隔离的 [Tools 服务](../../../src/agents/plugins/tools/README.md)、SystemPrompt、Session 和 Agent Loop。Loop 可以把工具声明交给模型，并将调用与结果记入 Session；Skill 的目录发现、授权绑定和加载仍需实现。当前工具的 `workingDirectory` 是调用方提供的授权工作目录，不能仅凭 Agent 名称或 Skill 文件所在路径推断访问权限。

## 使用示例

下列目录用于说明所属关系，不是当前已有文件或已经可运行的目录约定：

```text
src/agents/world-initialization-main-agent/
└── skills/
    └── world-planning/
        └── SKILL.md
```

1. 可信的应用装配为世界初始化主 Agent 提供其获授权的 Skill 来源。示例中的 `world-planning` 包含名称、用途描述和完整指导。
2. 模型发起任务前，世界初始化主 Agent 能看到 `world-planning` 的名称和用途，而不是默认获得所有 Skill 的全文。
3. 模型根据当前任务调用 Skill 加载工具并指定 `world-planning`，工具返回完整指导；Agent 根据指导处理当前任务。
4. 角色 Agent 没有获得该 Skill 的授权时，既不在自己的可用目录中看到它，也不能通过猜测名称加载它。
5. 同一 Agent 的不同实例按照各自装配的授权范围运行。实例销毁时释放其 Skill 和工具注册，不影响其他实例。

该示例不表示通过文件夹位置自动获得安全隔离，也不规定 Skill 的固定数量或题材分类。目录属于哪个 Agent、应用如何提供来源以及构建后如何定位资源，需要在实现前确定并验证。

## 能力和依赖

| 能力 | 职责 | 依赖 |
| --- | --- | --- |
| Skill 服务 | 注册与注销提供方、列出可用 Skill、按名称加载内容 | 提供方契约、明确的 Agent 作用域 |
| 文件系统提供方 | 在获授权的来源中发现 Skill，解析元信息并读取正文 | Skill 服务、文件输入校验和目录授权 |
| Agent 绑定 | 由可信装配为每个 Agent 实例指定可用的来源和范围 | Harness 实例作用域、服务与提供方 |
| 模型可见目录 | 向模型提供当前 Agent 可用 Skill 的名称和用途 | Agent 绑定、Skill 查询、现有请求与会话机制 |
| Skill 加载工具 | 接收 Skill 名称，从当前 Agent 的授权范围加载内容 | Skill 服务、Tools 服务 |
| 端到端调用 | 让模型看到目录、调用工具并在后续 Step 获取内容 | 目录发布、加载工具、Agent Loop 和 Session |

Skill 名称用于定位已授权范围内的内容，不是模型自行选择 Agent 身份或目录的权限凭据。共享、继承或委派子 Agent 时的权限由可信调用方明确赋予，本阶段不默认继承其他 Agent 的专属 Skill。

## 开发顺序

每一步开始前先说明问题、使用示例、输入、输出和预期行为，确认接口后再实现；完成必要验证并对照官方对应实现后，等待用户指示再进入下一步。不把下列职责机械转换成固定数量的 Agent 或工作流节点。

### 1. 创建世界初始化主 Agent 的 Skill 样例

**官方对照**：按照 [DeepSeek Harness 文件系统 Skill 格式](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/skill-filesystem/README.md)编写样例，核对 `SKILL.md` 的目录形式、`name`、`description` 和正文格式；样例内容服务本项目的世界初始化任务。

**问题与示例**：在 `src/agents/world-initialization-main-agent/` 下创建一个实际的 Skill 样例，供后续加载工具使用。样例的具体名称与指导内容先结合世界初始化任务讨论，不预设题材分类。

**范围**：参考官方 Skill 的组织方式，确定样例的目录、名称、用途描述和正文。样例应表达一个实际任务的指导，而不是只有空壳；本步只创建样例，不实现加载工具，也不因为文件位置就声称访问隔离已经生效。

**验收**：检查样例的名称、描述、内容和目录可以用于下一步的加载示例；明确它服务于世界初始化主 Agent，等待用户指示再开发工具。

### 2. 实现 Skill 加载工具

**官方对照**：参考 [DeepSeek Harness 的 Skill 加载工具](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/tool-skill/README.md)，对照工具名称、按 Skill 名称加载内容的输入输出和调用流程；同时核对其对 Skill 服务和提供方的依赖，以本项目已有 Tools 扩展点实现。

**问题与示例**：参考官方 `skill` 工具，调用方指定第 1 步样例的名称，工具从可信指定的来源加载并返回完整指导。

**范围**：先对照官方加载工具及其依赖的 Skill 服务、文件系统提供方，确定工具的参数、输出和调用方式。实现加载样例所必需的最小发现、元信息解析和按名称读取能力，并接入现有 Tools 服务；具体服务与提供方的边界参考官方设计，不将完整的多来源管理、Agent 绑定或模型目录发布提前扩展为本步的前置项目。

本步由可信调用方指定样例来源，工具不接受模型任意指定 Agent 身份或扩大读取范围的路径。需要解析 YAML 等外部格式时，评估成熟依赖的必要性、兼容性、许可证与维护情况；不手写不完整的通用解析器。

**验收**：以第 1 步样例验证按名称加载及正文返回，覆盖无匹配、无效元信息、读取失败、取消和路径越界；验证工具可通过现有 Tools 服务执行并清理。模型自动看到 Skill 目录、不同 Agent 的完整隔离和正式主 Agent 的装配分别在后续步骤验证，不把本步的直接工具调用当作已完成这些能力。

### 3. 完善 Skill 服务与文件系统提供方

**官方对照**：参考 [DeepSeek Harness Skill 服务](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/skill/README.md)和[文件系统提供方](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/skill-filesystem/README.md)，对照提供方注册、目录查询、按需加载和文件格式；未实现的官方能力明确记录。

**问题与示例**：在已有样例和加载工具的基础上，通过提供方列出多个 Skill 的摘要，并按名称加载其中一个正文。

**范围**：对照官方服务与文件系统提供方，完善实际需要的注册、注销、发现和读取契约，明确重复提供方、同名 Skill、未找到和提供方失败的语义。验证目录、符号链接和资源引用的访问范围；不提前引入尚无实际需求的多来源优先级和文件监听。

**验收**：使用固定提供方和临时文件验证摘要查询、按需加载、重复注册、同名冲突、读取错误和注销；明确说明已支持的 Skill 格式和与官方实现的差异。

### 4. 按 Agent 绑定 Skill 来源

**官方对照**：参考 [DeepSeek Harness Skill 服务](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/skill/README.md)的提供方与作用域管理，对照注册、可见范围和清理行为；本项目的 Agent 专属目录授权结合现有 Harness 实例隔离实现。

**问题与示例**：世界初始化主 Agent 和角色 Agent 各自装配 Skill 来源；即使两者运行在同一进程，角色 Agent 也不能列出或加载世界初始化主 Agent 的专属 Skill。

**范围**：结合现有 Factory、Preset 和 Cordis Context，确定可信配置如何把 Skill 来源绑定到 Agent 实例，以及服务和提供方由谁创建、关闭。配置不能由模型生成的 Agent ID 或路径扩大权限；同一 Agent 的不同实例也应按各自授权配置隔离。暂不实现子 Agent 权限继承或跨 Agent 共享策略。

**验收**：验证不同 Agent 和同一类型的不同实例的目录、加载结果及资源清理；通过名称猜测、同名 Skill 和未授权路径检查隔离，销毁一个实例不影响另一个实例。

### 5. 向模型提供 Skill 目录

**官方对照**：参考 [DeepSeek Harness Skill 工具](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/skill/tool-skill/README.md)提供给模型的 Skill 目录格式和发布时机，对照名称、用途描述及按需加载的关系；与本项目 Session 和 Loop 的差异需要明确记录。

**问题与示例**：Agent 接收用户构想时，模型能看到本实例获授权 Skill 的名称和用途，未加载的正文不提前混入请求。

**范围**：参考官方目录发布方式，对照现有 SystemPrompt、Session 和 Loop，确定目录如何进入模型上下文以及其所有权。先明确首次发布、无 Skill、发现不完整或失败时的行为；目录变化、重复发布、会话恢复是否属于本步，结合现有能力和示例确认，不能声称已经支持官方全部语义。

**验收**：固定模型替身捕获请求，验证只展示本 Agent 可用的摘要、不包含其他 Agent 的 Skill 和未加载正文；空目录或发现失败不伪装成成功发现。若修改 Session 事件或持久化格式，先确定版本和旧数据迁移或明确拒绝读取策略。

### 6. 组合验证与主 Agent 接入准备

**官方对照**：对照 [DeepSeek Harness Skill 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/docs/subsystems/skills.md)从提供方、目录发布到 `skill` 工具加载的完整关系和模型可见格式，逐项验证本项目支持的行为，并记录尚未实现的部分。

**问题与示例**：使用世界初始化主 Agent 的示例 Skill 和另一个 Agent 的独立 Skill，验证从可信装配、目录展示到工具加载的完整过程。

**范围**：先使用完成验证所需的测试 Preset 与固定模型替身，不提前实现正式世界初始化主 Agent 的创建入口。检查源码类型检查、独立包构建、产物运行和资源定位；若正式运行依赖随包分发的 Skill 文件，要明确构建产物如何携带和定位这些资源，不能依赖本机源码路径或上次构建残留。

**验收**：验证模型收到工具声明后按名称调用，正文进入后续 Step，Session 记录调用与结果；覆盖 Agent 间隔离、按需加载、错误和清理。检查测试编译和构建产物能够按声明入口运行。需要真实模型评价 Skill 选择效果时单独报告执行情况，固定替身不证明模型会正确选择 Skill。对照官方三个能力的职责与限制，记录已实现和尚未实现的差异。

## 本阶段不提前实现

- 不为地图、角色、题材等预设固定 Skill 清单，也不在尚无具体需求时批量编写业务 Skill。
- 不自动扫描其他 Agent 的私有目录；不让模型通过路径或名称绕过可信装配的授权范围。
- 不提前实现所有官方提供方、全局共享规则、监听热更新、子 Agent 委派及权限继承。
- 不将正式世界资料、角色认知或用户确认状态混入 Skill 服务；这些能力由各自所属模块处理。

## 开发前需要确认

- 样例 Skill 的具体任务、目录和内容在第 1 步确认；加载工具的输入输出及所需最小服务在第 2 步确认。
- Skill 服务和文件系统提供方如何注册、处理冲突和清理，以及 Agent 专属 Skill 的可信授权方式，分别在第 3、4 步确认。
- 可用目录如何进入模型请求，以及后续对目录变化和 Session 恢复的要求；结合第 5 步的真实使用场景决定。源码资源如何发布到构建产物，在组合验证前确定。
