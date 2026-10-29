# 角色专有插件与组合开发计划

本文细化[长期开发计划](../../development-plan.md#开发顺序)中“角色专有插件与组合”的开发顺序。角色、导演等业务 Agent 的目标职责分别见[角色设计](character-agent.md)、[导演设计](director-agent.md)及[写作 Agent 总设计](agents.md)；这些设计中的目标契约不等同于当前可运行接口。

## 目标与现状

复用现有 SystemPrompt 服务，逐个开发各 Agent 的系统提示词插件，通过现有 Preset 选择对应插件，并检查旧入口与新调用方式的衔接。提示词注册归当前 Agent 作用域，销毁时清理。

当前 `character-agent` 和 `director-agent` Preset 已装配基础服务，并含示例 memory 插件；它们尚未装配角色或导演专有提示词。现有 `CharacterAgent`、`DirectorAgent` 仍使用独立的旧执行路径，不能把它们的能力视作已接入 Harness。旧小说数据及其读取和存储方式不作为本计划的可靠前提；工具计划中的[第 9 步](tool-plugin-development-plan.md)暂缓，待具体数据和应用场景确定后再设计。

## 官方参考与项目边界

- 对照 DeepSeek Harness 的 [SystemPrompt](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/README.md)、[Agent](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/README.md) 和 [Agent Preset](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset-registry/README.md) 源码与文档，重点学习插件通过作用域注册提示词、Preset 组合能力、销毁时清理的方式。每一步实施前重新核对对应实际代码，明确参考版本与差异。
- 本项目沿用已有 `AgentPreset`、插件 ID、Factory 和每实例隔离的 Context，不预先引入官方另一套 Preset 管理体系。官方不存在本项目小说角色的业务定义；角色资料、可见范围和导演职责以项目设计及可信数据源为准，不冒充官方接口或命名。
- 对话记录归 Session；角色经历、人物状态和小说资料归业务数据。示例 `mock-memory` 不能作为正式角色记忆来源。现有旧 Agent 的输入、行为和调用方先调查验证，再决定如何复用或接入；未经单步确认不删除或替换旧入口。

## 每步执行规则

开始每一步前，先说明问题、官方实际方案、本项目使用示例、输入输出和预期行为，等待用户确认接口与方案。确认后只实现该步所需最小功能；使用固定 LLM Adapter 和明确的测试输入做可重复测试，必要时增加受控真实模型验证。开发时同步提供 VS Code 调试方式。每步验证后说明与官方的异同并停下，等待下一步指示。数据源、接口和尚无实现的能力不提前虚构为现有服务。

## 开发步骤

**1. 开发角色 Agent 的系统提示词插件**

对照官方提示词贡献方式和现有 SystemPrompt 服务，确定角色 Agent 的提示词内容、读取方式和装配接口，经确认后实现角色专有提示词插件并接入现有角色 Preset。使用明确的测试输入验证提示词进入实际模型请求、不同实例互不串用以及销毁时清理；提供 VS Code 调试方式。不依赖旧小说数据或实现资料读写。

**2. 开发导演 Agent 的系统提示词插件**

沿用已确认的通用 SystemPrompt 服务和提示词接入方式，确定导演职责提示词及其读取方式，经确认后实现导演专有插件并接入现有导演 Preset。验证导演与角色的提示词隔离、实际请求内容及清理，并提供 VS Code 调试方式。

**3. 逐个开发其他 Agent 的系统提示词插件**

对写作、审计、内容审查等 Agent，逐个核对现有职责与提示词，分别说明并确认接口、内容和装配方式后，再实现各自的提示词插件。存在对应 Preset 时接入该 Preset；没有现成 Preset 的 Agent，先说明所需装配方式并确认。每个 Agent 分别验证提示词隔离、请求内容和清理，提供调试方式；不一次性开发全部 Agent 后再统一确认。

**4. 检查旧入口与新调用方式的衔接**

对照现有旧 Agent 的实际调用方和 Harness 的调用方式，列出入口、输入输出、生命周期及尚未覆盖的业务能力差异，重点检查 Character Agent。说明后续调用方如何衔接及尚需确定的问题；本步只做检查，不实施迁移。未经确认不删除或替换旧入口，不把示例 memory 当作正式角色记忆。

## 不在本计划中提前实现

小说数据的读取与存储、角色和导演的资料查询工具及其授权，待具体数据和 Agent 应用场景确定后另行设计；工具计划第 9 步保持待完成。Session 持久化、长期记忆检索与摘要、权限审批、MCP、PTC、复杂工具调度，以及小说或章节工作流的整体迁移按对应开发计划和实际需求另行设计。角色和导演设计中尚未实现的全部业务能力不因本计划自动纳入首个插件步骤。
