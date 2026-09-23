# @fly-novel/agents

小说创作 Agent 的私有 pnpm 工作区包，设计契约见[写作 Agent 模块设计](../../docs/modules/agents/agents.md)。公共入口为 `index.ts`，导入不创建 Agent 或发起网络请求；四类工厂尚待按设计实现。

各模板的输入、处理逻辑与外部调用草案见[角色](../../docs/modules/agents/character-agent.md)、[导演](../../docs/modules/agents/director-agent.md)、[写作](../../docs/modules/agents/writer-agent.md)和[评估](../../docs/modules/agents/evaluator-agent.md)详细设计；文档示例不是当前可运行接口。

## 构建与引用

公共入口导出抽象基类 `BaseAgent`，以及直接继承它的 `CharacterAgent`、`DirectorAgent`、`WriterAgent`、`EvaluatorAgent`。四个子类支持无参数实例化，仅提供类骨架，没有 `run` 方法、模型调用或文件读写。基础使用方式：

```ts
import { CharacterAgent, DirectorAgent, WriterAgent, EvaluatorAgent } from "@fly-novel/agents";

const character = new CharacterAgent();
const director = new DirectorAgent();
const writer = new WriterAgent();
const evaluator = new EvaluatorAgent();
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
