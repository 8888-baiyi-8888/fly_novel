# @fly-novel/system-prompt

通用 SystemPrompt 对象和 Cordis 服务插件。该包负责提示词 Section、变量、组装与渲染，不依赖 `@fly-novel/agents`；Harness 插件注册定义由 Agents 包提供。

## 独立使用

```ts
import { renderPrompt, SystemPrompt } from '@fly-novel/system-prompt'

const prompt = new SystemPrompt()
prompt.section({ name: 'identity', order: 0, text: '你是写作助手。' })
const text = renderPrompt(prompt.assemble())
```

## Cordis 服务

`systemPromptPlugin` 为当前 Cordis Context 提供 `systemPrompt` 服务，并在插件销毁时释放提示词注册。Harness 消费方使用 `@fly-novel/agents` 提供的 `systemPromptPluginDefinition` 注册插件并由 Preset 选择。

## 构建

在仓库根目录运行：

```bash
pnpm --filter @fly-novel/system-prompt typecheck
pnpm --filter @fly-novel/system-prompt build
```
