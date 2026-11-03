# @fly-novel/agents

小说创作 Agent 的私有 pnpm 工作区包，设计契约见[写作 Agent 模块设计](../../docs/modules/agents/agents.md)。公共入口为 `index.ts`，导入不创建 Agent 或发起网络请求。

各模板的输入、处理逻辑与外部调用草案见[角色](../../docs/modules/agents/character-agent.md)、[导演](../../docs/modules/agents/director-agent.md)和[写作](../../docs/modules/agents/writer-agent.md)详细设计；文档示例不是当前可运行接口。

## 源码布局

- `core/`：Deep Agent 基类、Cordis Harness 的实例 handle、注册表、契约和 bootstrap。
- `runtime/`：应用模型解析与结构化输出辅助函数，以及 Harness 的 Agent 工厂和管理器。
- `plugins/`：Harness 的 memory、LLM 服务与插件注册；真实 Agent Loop Runtime 属于独立工作区包 `@fly-novel/agent-loop`。`plugins/index.ts` 汇总各包及模块提供的注册定义。通用 Session 和 SystemPrompt 位于各自独立工作区包中。
- `plugins/tools/`：独立工作区包 `@fly-novel/tools`，提供工具定义与注册执行服务；具体工具见[工具目录](../tools/README.md)。
- `plugins/subagent/subagent/`：独立工作区包 [`@fly-novel/subagent`](plugins/subagent/subagent/README.md)，提供一次性子 Agent 委派服务及 Cordis 插件。
- `plugins/skill/`、`plugins/skill-filesystem/`：独立工作区包，分别提供 Skill 注册查询服务和文件系统来源；各自包含 Cordis 插件及 Harness 注册定义。
- `plugins/tool-skill/`：独立工作区包，注册 Skill 加载工具并发布模型可见目录。
- `character/`、`director/`、`writer/`：各 Agent 的业务实现与专属类型；`character/` 另含 Harness 角色插件样例和定义列表。
- `character/plugins/system-prompt/`、`director/plugins/system-prompt/`：角色和导演的专有提示词插件独立工作区包，包含各自的 Harness 注册定义。
- `world-initialization-main-agent/preset.ts`：世界初始化主 Agent 的内置 Preset，组合提示词、Skill 及基础服务。
- `world-initialization-main-agent/plugins/system-prompt/`：世界初始化主 Agent 的专有提示词插件独立工作区包，包含 Harness 注册定义。
- `world-initialization-main-agent/skills/`：世界初始化主 Agent 的 Skill 样例；运行时来源由可信应用提供。
- `tests/`：按包运行的自动化测试。

模板之间不跨目录引用业务实现；它们通过 `core/` 共享 Agent 创建与文本调用，通过 `runtime/` 共享应用模型解析和结构化输出执行能力。`index.ts` 是唯一公共导出入口。

## Cordis Harness

`await bootstrapAgents()` 创建 Cordis 根 Context、插件注册表、Preset 注册表、工厂和 Manager，遍历 `plugins/index.ts` 汇总的内置定义注册插件，并注册角色、导演、写作和世界初始化主 Agent 的 Preset。新增内置插件时在所属模块导出注册定义，再加入汇总列表；各 Agent 的 Preset 通过插件 ID 选择所需插件。`manager.create({ id, presetId })` 创建 Agent handle，并要求 Preset 装配提供 `agentLoop` 的插件。插件按 Preset 顺序装配，Cordis 按插件的 `inject` 声明安排启动。工厂依据插件的 `provide` 元数据在每个 Agent 的 Context 中隔离服务。每个 Agent 持有一个 Cordis 父插件作用域；`agent.run()` 将输入交给该实例的 `agentLoop` 服务，memory 可通过 `agent.context.get('memory')` 单独访问。`manager.dispose(id)` 和 `manager.disposeAll()` 会等待作用域销毁；失败的初始化不会进入 Manager。

Agent 初始化先激活父作用域，再等待所选插件及其依赖链启动；插件启动失败或依赖无法就绪时清理作用域并拒绝创建。

角色和导演 Preset 均装配真实 `agent-loop-runtime`、`system-prompt`、`llm` 与 `session`。创建 Agent 时，应用须通过 `pluginConfigs['agent-loop-runtime']` 提供 `provider`、`model`，并通过 `pluginConfigs.llm` 提供 `{ adapters: [{ providers: [provider], adapter }] }`。`llmPluginDefinition` 在该 Agent 的 Context 中提供独立 LLM 服务，并随插件作用域注销路由。配置和凭据由应用入口读取，插件只接收已创建的适配器。

`systemPromptPluginDefinition` 已加入内置插件注册表。Preset 声明 `{ pluginId: 'system-prompt' }` 后，每个 Agent Context 会获得独立的 `systemPrompt` 服务，可注册 Section、变量并调用 `assemble()`；Agent 销毁时插件会清除并关闭服务。SystemPrompt 核心对象、Cordis 服务插件、注册定义与渲染接口由独立的 [`@fly-novel/system-prompt`](plugins/system-prompt/README.md) 包提供。

`skills`、`skill-filesystem` 和 `tool-skill` 插件定义已加入内置注册表，世界初始化主 Agent 的 Preset 装配这些插件和 `tools`。`skills` 提供独立的 Skill 服务，`skill-filesystem` 需要可信调用方配置绝对 `root` 并向服务注册来源，`tool-skill` 使用同一实例的服务并在每个模型 Step 前提供可调用的 Skill 摘要。Skill 和工具服务不会从根 Context 继承注册；作用域销毁时注销工具和来源并关闭服务。其他 Agent 可在自己的 Preset 中选择这些插件。

`subagent` 插件定义已加入内置注册表；Preset 显式选择后，每个 Agent 获得独立的 `subagents` 服务。Agent 销毁时等待自身装配的服务关闭并向调用方报告清理失败；不会关闭仅从根 Context 继承的服务。该服务不自动装配 Provider，注册、启动和资源归属见 [SubAgent 包说明](plugins/subagent/subagent/README.md)。

### 创建世界初始化主 Agent

可信应用使用已有 Manager 创建并销毁实例。模型适配器、Skill 根目录和授权工作目录均由应用提供；Skill 根目录必须位于授权工作目录内。

```ts
import { bootstrapAgents } from '@fly-novel/agents'
import type { LlmAdapter } from '@fly-novel/llm'

declare const adapter: LlmAdapter // 应用创建的适配器
declare const skillRoot: string // 已部署的 Skill 根目录，绝对路径
declare const workingDirectory: string // 包含 skillRoot 的授权目录

const { manager } = await bootstrapAgents()
try {
  const agent = await manager.create({
    id: 'world-main',
    presetId: 'world-initialization-main-agent',
    pluginConfigs: {
      'agent-loop-runtime': { provider: 'example', model: 'example-model', workingDirectory },
      llm: { adapters: [{ providers: ['example'], adapter }] },
      'skill-filesystem': { root: skillRoot },
    },
  })
  const result = await agent.run({ prompt: '我想写一个玄幻世界。' })
  console.log(result.content)
} finally {
  await manager.disposeAll()
}
```

本入口提供基础对话和工具能力；理解结果的程序确认、超时处理和世界规划业务尚未实现。仓库内玄幻 Skill 样例不会随构建产物自动复制，部署应用需要显式准备 Skill 目录，见[工具说明](../tools/README.md)。

`@fly-novel/session-persistence` 定义 `sessionPersistence` 服务及会话句柄契约；`JsonlSessionPersistence` 提供 JSONL 文件后端。后端须显式指定绝对 `root`，按编码后的 Session ID 分目录保存项目格式 `session.v2.jsonl`；读取旧 v1 文件，写打开时保留 v1 并建立 v2。读取不完整尾部时只返回完整记录，写打开时截断尾部；完整记录无效或版本不支持时拒绝读取。写句柄创建后，后端接收同 ID 的 Session 事件并顺序写入，`sessions.flush(session)` 等待写入并报告失败。Agent Loop 可通过 `sessionId` 新建或 `resumeSessionId` 恢复持久化会话，应用负责装配后端；文件格式与官方格式不兼容。接口和调试方式见[会话持久化调试](../../docs/cookbook/session-persistence-debug.md)。

角色 Preset 同时装配 `character-system-prompt`，在角色实例中注册角色扮演职责提示词；具体角色信息和场景由调用输入提供。插件随 Agent 作用域注销，不读取角色档案。调试步骤见[角色提示词调试](../../docs/cookbook/character-system-prompt-debug.md)。

导演 Preset 装配 `director-system-prompt`，在导演实例中注册导演职责提示词；创作目标、世界规则和人物状态由调用输入提供。插件随 Agent 作用域注销。调试步骤见[导演提示词调试](../../docs/cookbook/director-system-prompt-debug.md)。

写作 Preset 装配 `writer-system-prompt`，复用旧写作 Agent 的完整系统提示词；写作材料由调用输入提供。插件随 Agent 作用域注销。调试步骤见[写作提示词调试](../../docs/cookbook/writer-system-prompt-debug.md)。

Preset 声明 `{ pluginId: 'tools' }` 后，Agent Context 获得独立的 `tools` 服务。`register(definition)` 返回注销函数；`get(name)`、`definitions()` 和 `schemas()` 查询定义与模型可见 schema，重复名称被拒绝，Agent 销毁时清理注册表。服务不自动注册具体工具；`execute` 串行处理工具调用批次，返回按调用 ID 关联的规范值、模型内容或错误。

### Agent Loop 调用契约

`AgentLoop.run({ prompt })` 每次调用对应一个 Turn，成功返回 `{ content }`；执行失败或取消时以拒绝的 Promise 向调用方传播错误。`agent.cancel()` 中止当前请求并拒绝尚未开始的排队调用；活动 Turn 在 Session 写入 `aborted` 结束原因。`agent.dispose()` 先等待 Loop 取消并完成 Session 收尾，再销毁 Cordis 插件作用域。Loop 按顺序执行同一 Agent 的并发 `run()` 调用；工具调用后进入下一 Step。

`@fly-novel/agent-loop` 导出 `AgentLoopRuntime`、插件和 Harness 注册定义。模型请求、工具调用、Session 记录及配置见 [Agent Loop 包说明](plugins/loop/README.md)。

逐步检查注册、装配、路由隔离和清理时，使用[LLM 插件调试步骤](../../docs/cookbook/llm-plugin-debug.md)。

角色插件样例定义在 `character/example-memory-plugin.ts`，由 `character/plugins.ts` 导出、`plugins/index.ts` 汇总注册，再由 `character/preset.ts` 按 ID 装配。它提供仅在当前 Harness Agent 实例中保存字符串的 `characterExampleMemory` 服务，不持久化数据。

```ts
import { bootstrapAgents } from '@fly-novel/agents'
import type { LlmAdapter } from '@fly-novel/llm'

declare const provider: string // 由应用配置读取
declare const model: string
declare const adapter: LlmAdapter // 由应用配置创建并注入

async function main() {
  const { manager } = await bootstrapAgents()
  try {
    const agent = await manager.create({
      id: 'character-1',
      presetId: 'character-agent',
      pluginConfigs: {
        'agent-loop-runtime': { provider, model },
        llm: { adapters: [{ providers: [provider], adapter }] },
      },
    })
    const result = await agent.run({ prompt: '你好' })
    console.log(result.content)
  } finally {
    await manager.disposeAll()
  }
}

void main()
```

`@fly-novel/agents` 保持 CommonJS 构建；`bootstrapAgents()` 使用动态导入加载 ESM 版 `@deepseek-ai/cordis`。角色和导演 Harness Preset 使用真实 Agent Loop，经当前 Agent 的 LLM 服务请求模型，并将成功对话消息记录在 Session。memory 插件目前仍是注册与生命周期替身，不保存长期记忆。

## 构建与引用

公共入口导出抽象基类 `BaseAgent` 和 `WriterAgent`。写作 Agent 接收应用创建的模型实例，并通过 `generate(content)` 调用 Deep Agents。角色和导演 Agent 的创建方式见上方 Cordis Harness 说明。基础使用方式：

```ts
import { WriterAgent } from "@fly-novel/agents";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";

declare const model: BaseLanguageModel; // 由应用配置模型与 API 凭据后创建
const writer = new WriterAgent({ model });
```

在仓库根目录执行：

```bash
pnpm install
pnpm --filter @fly-novel/agents typecheck
pnpm --filter @fly-novel/agents build
```

包使用 CommonJS，TypeScript 使用 NodeNext 解析包导出。构建产物位于本包 `dist/`，仅公共入口通过 `exports` 暴露。调用方声明 `@fly-novel/agents` 的 `workspace:*` 依赖，通过包名导入，不跨包相对导入内部源码。

编辑器与根项目类型检查通过源码映射解析公共入口，不要求预构建。正式运行使用包内构建产物；根项目构建与测试编译先构建本包。测试放在本包 `tests/`，通过根项目测试入口编译和运行，正式包构建排除测试。

运行依赖由本包声明，编译配置继承仓库根配置。本包是仓库内独立依赖与构建单元，未配置对外发布；脱离仓库维护需要单独提供共享编译配置。

## SDK 示例参考

以下保留初始示例供接入时参考，不是可运行的包入口：`search`、`fetchUrl` 未定义，模型未接入项目配置，路径和顶层 `await` 也未适配本包。实际模板不得直接加载项目开发规则作为写作记忆。

```ts
import { createDeepAgent } from "deepagents";

const agent = await createDeepAgent({
  model: "openai:gpt-5.5",
  systemPrompt: "You are a helpful assistant.",
  tools: [search, fetchUrl],
  memory: ["./AGENTS.md"],
  skills: ["./skills/"],
});
```
