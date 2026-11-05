# @fly-novel/subagent-fork-in-process

Fork 插件在父 Agent 作用域注册 `fork` Provider。启动时校验父身份、SubAgent 服务及标准 Agent Loop 归属，从 Loop 捕获已结束轮次的历史，再通过共享 Driver 和可信创建函数启动子 Agent。运行句柄交付后由调用方等待结果并释放。父作用域没有独立 SubAgent 服务或 Loop 时不能使用继承的根服务冒充。

可信应用通过 `createForkAgentCreator(framework, presets)` 提供允许的 Preset、模型和插件配置。`presetId` 必填；可选 `parameters` 通过现有创建链复制到子 Agent。子会话是独立内存 Session，不能指定持久化 ID。可信应用应确保所选插件不会自行恢复或共享会话。

首版只接受纯文本的已结束轮次，不接受工具调用、工具结果、非文本内容或私有重放状态；当前未结束轮次不继承。两个现有模型委派工具仍使用 Spawn；本包不提供可继续运行或后台通知。

以下示例由可信应用提供模型适配器和路由。父 Agent 先完成一轮，再创建角色子 Agent；实际任务所需的角色资料仍须由调用方提供。

```ts
import { bootstrapAgents, characterAgentPreset, createForkAgentCreator } from '@fly-novel/agents'
import type { LlmAdapter } from '@fly-novel/llm'

async function forkExample(adapter: LlmAdapter, provider: string, model: string) {
  const framework = await bootstrapAgents()
  const config = {
    'agent-loop-runtime': { provider, model },
    llm: { adapters: [{ providers: [provider], adapter }] },
  }
  const create = createForkAgentCreator(framework, { 'character-agent': config })
  framework.presets.register({
    ...characterAgentPreset,
    id: 'fork-example-parent',
    plugins: [...characterAgentPreset.plugins, { pluginId: 'subagent' }, { pluginId: 'subagent-fork-in-process' }],
  })
  try {
    const parent = await framework.manager.create({ id: 'parent', presetId: 'fork-example-parent',
      pluginConfigs: { ...config, 'subagent-fork-in-process': { create } } })
    await parent.run({ prompt: '世界中有一座浮空城。' })
    const run = await parent.context.subagents.start('fork', {
      parent, presetId: 'character-agent', prompt: '分析城中守卫的动机。',
      parameters: { characterId: 'guard-1' }, signal: new AbortController().signal,
    })
    try { return await run.result } finally { await run.dispose() }
  } finally { await framework.manager.disposeAll() }
}
```

`run.result` 的 `stopReason` 区分完成、错误和取消；无法表达为任务终态的故障会使结果拒绝。示例中的父 Agent 和子 Agent 共用模型配置仅为演示；可信应用应确认目标模型可以接收所选父历史。调用链和清理由[公开入口集成测试](../../../tests/subagent-fork-public-integration.test.ts)使用固定模型替身验证，不代表真实模型调用已验证。
