#### 系统提示词插件

**目标**：参考 DeepSeek Harness 官方 [`@deepseek-ai/dsh-system-prompt`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/README.zh.md)，逐步实现通用 SystemPrompt 插件。

以官方架构为最终参考，但不一次性实现所有功能。先建立最小可运行闭环，再沿主线逐步增强，每一步对照官方对应设计。

当前仅开发 `src/agents/plugins/system-prompt/`，不涉及角色、导演等业务插件及真实 Loop 接入。

**开发主线：**

1. **基础对象**：了解官方 SystemPrompt 的整体职责和使用方式，建立最小服务对象，能够保存并读取提示词。
2. **Section 注册**：参考官方 `PromptSection` 和 `section()`，支持多个提示词段的注册、管理及注销。
3. **组装与渲染**：实现 `assemble()` 和 `renderPrompt()`，完成从多个 Section 到最终系统提示词的核心闭环。
4. **动态能力**：逐步增加动态文本、变量管理与插值，理解组装时求值和渲染时处理的区别。
5. **作用域与覆盖**：参考官方设计，逐步加入作用域隔离、全局段遮蔽及 `complete` 替换能力。
6. **Cordis 接入**：将 SystemPrompt 接入现有插件注册表，通过 Preset 装配，验证不同 Agent 的服务隔离及插件生命周期。
7. **SystemPrompt 独立包**：将 `src/agents/plugins/system-prompt/` 建立为 `@fly-novel/system-prompt` 工作区包，形成独立的包清单、编译配置和公共导出入口，使提示词对象可脱离 `@fly-novel/agents` 单独构建和使用。整理 SystemPrompt 核心能力与 Harness 插件注册适配层的依赖边界，避免 SystemPrompt 核心反向依赖 Agent 包；同步 workspace、包依赖、导入路径及构建配置。Cordis 插件可由该包提供，但 Harness 注册表和 Preset 仍由 `@fly-novel/agents` 管理。验收独立包构建、公共入口导入、Agents 集成构建及现有行为测试。
8. **其他官方能力（其他插件开发后，再进行）**：了解动态 Runtime Context、工具 Schema 贡献与排序、Assemble Waterfall 等机制。属于当前通用模块的能力按需实现，依赖其他子系统的部分留到后续集成阶段。

**开发要求：**

- 每次只推进一步，先了解官方对应设计及使用方式，再讨论并实现。
- 每一步完成后进行实际调用验证，并简要对照官方实现。
- 不提前开发后续功能，但需说明后续可扩展的能力。
- 不要求逐行复刻源码，但核心接口和架构尽量与官方保持一致，不能擅自重新设计简化替代品。
- 每一步完成后停止，等待下一步指示。

最终实现一个符合 DSH 设计思路、可独立使用并能接入现有 Harness 的 SystemPrompt 插件。
