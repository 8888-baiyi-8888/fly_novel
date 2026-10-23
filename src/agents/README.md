# @fly-novel/agents

小说创作 Agent 的私有 pnpm 工作区包，设计契约见[写作 Agent 模块设计](../../docs/modules/agents/agents.md)。公共入口为 `index.ts`，导入不创建 Agent 或发起网络请求。

各模板的输入、处理逻辑与外部调用草案见[角色](../../docs/modules/agents/character-agent.md)、[导演](../../docs/modules/agents/director-agent.md)、[写作](../../docs/modules/agents/writer-agent.md)、[审计](../../docs/modules/agents/audit-agent.md)和[内容审查](../../docs/modules/agents/censor-agent.md)详细设计；文档示例不是当前可运行接口。

## 源码布局

- `core/`：Deep Agent 基类、Cordis Harness 的实例 handle、注册表、契约和 bootstrap。
- `runtime/`：应用模型解析与结构化输出辅助函数，以及 Harness 的 Agent 工厂和管理器。
- `plugins/`：Harness 使用的 mock loop、memory 与 LLM 服务插件；各已实现模块导出注册定义，`plugins/index.ts` 汇总内置定义。通用 Session 插件位于此目录下的独立 [`@fly-novel/session`](plugins/session/README.md) 包，注册方式相同。
- `character/`、`director/`、`writer/`、`audit/`、`censor/`：各模板的业务实现与专属类型；`character/` 另含 Harness 角色插件样例和定义列表。
- `tests/`：按包运行的自动化测试。

模板之间不跨目录引用业务实现；它们通过 `core/` 共享 Agent 创建与文本调用，通过 `runtime/` 共享应用模型解析和结构化输出执行能力。`index.ts` 是唯一公共导出入口。

## Cordis Harness

`await bootstrapAgents()` 创建 Cordis 根 Context、插件注册表、Preset 注册表、工厂和 Manager，遍历 `plugins/index.ts` 汇总的内置定义注册插件，并注册角色与导演 Preset。新增内置插件时在所属模块导出注册定义，再加入汇总列表；各 Agent 的 Preset 通过插件 ID 选择所需插件。`manager.create({ id, presetId })` 创建 Agent handle，并要求 Preset 装配提供 `agentLoop` 的插件。插件按 Preset 顺序装配，Cordis 按插件的 `inject` 声明安排启动。工厂依据插件的 `provide` 元数据在每个 Agent 的 Context 中隔离服务。每个 Agent 持有一个 Cordis 父插件作用域；`agent.run()` 将输入交给该实例的 `agentLoop` 服务，memory 可通过 `agent.context.get('memory')` 单独访问。`manager.dispose(id)` 和 `manager.disposeAll()` 会等待作用域销毁；失败的初始化不会进入 Manager。

`llmPluginDefinition` 已加入内置插件注册表。需要模型服务的 Preset 声明 `{ pluginId: 'llm' }`；应用创建实例时通过 `pluginConfigs.llm` 提供 `{ adapters: [{ providers: ['provider-id'], adapter }] }`。插件要求至少一条适配器路由，在该 Agent 的 Context 中提供 `llm` 服务，并随插件作用域注销路由。配置和凭据由应用入口读取，插件只接收已创建的适配器。当前角色与导演的 mock Preset 不装配 LLM，mock loop 仍只回显输入。

逐步检查注册、装配、路由隔离和清理时，使用[LLM 插件调试步骤](../../docs/cookbook/llm-plugin-debug.md)。

角色插件样例定义在 `character/example-memory-plugin.ts`，由 `character/plugins.ts` 导出、`plugins/index.ts` 汇总注册，再由 `character/preset.ts` 按 ID 装配。它提供仅在当前 Harness Agent 实例中保存字符串的 `characterExampleMemory` 服务，不接入独立的 `CharacterAgent` 业务类，也不持久化数据。

```ts
import { bootstrapAgents } from '@fly-novel/agents'

async function main() {
  const { manager } = await bootstrapAgents()
  try {
    const agent = await manager.create({ id: 'character-1', presetId: 'character-agent' })
    const result = await agent.run({ prompt: '你好' })
    console.log(result.content)
  } finally {
    await manager.disposeAll()
  }
}

void main()
```

`@fly-novel/agents` 保持 CommonJS 构建；`bootstrapAgents()` 使用动态导入加载 ESM 版 `@deepseek-ai/cordis`。当前 loop 和 memory 仅用于注册与生命周期验证；`agent.run()` 调用 mock loop 回显输入，不调用模型，也不保存长期记忆。

## 构建与引用

公共入口导出抽象基类 `BaseAgent`，以及 `CharacterAgent`、`CharacterAgentManager`、`DirectorAgent`、`WriterAgent`、`AuditAgent`、`CensorAgent`。`CharacterAgentManager` 按小说内的角色 ID 缓存实例，达到容量上限时淘汰最久未使用的实例；章节驱动在一次运行结束后调用 `clear()`。章节模拟把角色档案和当前状态作为 `characterInfos` 提供给对应角色 Agent，不要求复制到旧版 `novel_data` 目录。`CharacterAgent` 通过应用启动时注册的模型解析器调用 Deep Agents；导演、写作、审计和内容审查 Agent 接收应用创建的模型实例，并通过 `generate(content)` 调用 Deep Agents。它们不读取应用配置或凭据，也不读写文件。基础使用方式：

```ts
import { CharacterAgent, DirectorAgent, WriterAgent, AuditAgent, CensorAgent } from "@fly-novel/agents";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";

const character = new CharacterAgent({
  modelId: "default",
  storyId: "novel-river",
  branchId: "main",
  characterId: "character-lin-zhou",
});
declare const model: BaseLanguageModel; // 由应用配置模型与 API 凭据后创建
const director = new DirectorAgent({ model });
const writer = new WriterAgent({ model });
const audit = new AuditAgent({ model });
const censor = new CensorAgent({ model });
```

应用启动时调用 `configureAgentRuntime({ resolveModel, characterDataDirectory, characterMemoryDirectory })` 注册模型解析器、小说数据根目录和记忆根目录。`CharacterAgent` 初始化时加载一次该角色的全部记忆，并在后续运行中复用及更新内存副本。`sceneId` 只用于将本轮经历归档到 `<根目录>/<storyId>/character_agent/<branchId>/<characterId>/memory/<sceneId>.json`，同一场景多轮记录追加到同一文件。通过 `CharacterMemory.getAllMemories({ storyId, branchId, characterId })` 查询持久化的全部记忆。框架创建和调用函数位于 `runtime/`，不从包入口导出，不读取应用配置或凭据。会话边界见[角色对外入口](../../docs/modules/agents/character-agent.md#31-对外入口)。

创建 `CharacterAgent` 时只提供小说与角色 ID。应用启动时通过 `configureAgentRuntime` 注册小说数据根目录，系统提示词模块按固定目录结构读取 `<数据根目录>/<storyId>/world-background.md` 和 `<数据根目录>/<storyId>/character_agent/<branchId>/<characterId>/profile.md`，并在构造阶段初始化 `system_prompts`。

调用方通过 `run({ sceneId, scene, responseFormat: schema })` 提供稳定场景 ID、当前场景和 Zod 对象 Schema，自行定义输出字段；Agent 没有内置字段枚举或预设输出结构。模型调用中间件支持每轮不同 Schema。使用 `result.structuredResponse` 读取通过结构校验的结果，返回类型从外部 Schema 推导。调用样例及错误语义见[角色对外入口](../../docs/modules/agents/character-agent.md#31-对外入口)。业务一致性校验与结构校验分开。

可使用根项目的 `pnpm run character-agent-example` 手动调试同一实例的连续两轮模型调用。该入口负责读取本机 DeepSeek 配置与凭据，模型创建不属于 Agent 包。

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
