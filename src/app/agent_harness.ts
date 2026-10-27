import assert from 'node:assert/strict'
import { bootstrapAgents } from '@fly-novel/agents'
import type { AgentLoopResult } from '@fly-novel/agent-loop'

/** 手动调试 Preset 装配、Agent.run() 和 Cordis 作用域销毁。 */
export async function debugAgentHarness(prompt: string): Promise<AgentLoopResult> {
  if (!prompt.trim()) throw new Error('调试输入不能为空')

  const { plugins, presets, manager } = await bootstrapAgents()
  console.log('插件：', plugins.list().map((plugin) => plugin.id))
  console.log('Preset：', presets.list().map((preset) => preset.id))

  let agent: Awaited<ReturnType<typeof manager.create>> | undefined
  try {
    agent = await manager.create({
      id: 'debug-character',
      presetId: 'character-agent',
    })
    console.log('Agent：', agent.info, '状态：', agent.state)

    const result = await agent.run({ prompt })
    assert.equal(result.content, `[角色 Agent] ${prompt}`)
    console.log('输出：', result.content)
    return result
  } finally {
    await manager.disposeAll()
    console.log('销毁后状态：', agent?.state ?? '未创建')
  }
}

if (require.main === module) {
  const prompt = process.argv.slice(2).join(' ').trim() || '你明天会回来吗？'
  void debugAgentHarness(prompt).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
