import { mkdir, realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Agent } from '@fly-novel/agents'
import { createWorldInitializationAgentWithWorkspace } from './agents/index.js'

/** 创建缺失的调试目录；已有文件和目录保持原样。 */
export async function prepareFileDebugWorkspace(base = resolve('tmp/world-initialization-files-debug')) {
  await mkdir(base, { recursive: true })
  const viewRoot = await realpath(base)
  const draftRoot = join(viewRoot, 'draft')
  const confirmedRoot = join(viewRoot, 'confirmed')
  await mkdir(draftRoot, { recursive: true })
  await mkdir(confirmedRoot, { recursive: true })
  return { viewRoot, draftRoot, confirmedRoot }
}

/** 在同一 Agent 会话中处理输入并显示本轮工具调用和结果状态。 */
export async function runFileDebugSession(agent: Agent, lines: AsyncIterable<string>, write: (text: string) => void): Promise<void> {
  write('输入任务后回车；输入 /exit 结束。')
  for await (const line of lines) {
    if (line.trim() === '/exit') break
    if (!line.trim()) continue
    const session = agent.context.sessions.list()[0]
    if (!session) throw new Error('Agent 没有可用的 Session')
    const offset = session.read().length
    const result = await agent.run({ prompt: line })
    for (const event of session.read().slice(offset)) {
      if (event.type === 'tool/call') write(`工具> ${event.data.name} ${event.data.arguments}`)
      if (event.type === 'tool/result') write(`工具结果> ${event.data.error ? `失败 (${event.data.error.code})` : '成功'}`)
    }
    write(`Agent> ${result.content}`)
  }
}

/** 通过项目本机模型配置，在独立的测试工作区交互运行。 */
export async function debugWorldInitializationFiles(): Promise<void> {
  const workspace = await prepareFileDebugWorkspace()
  const agent = await createWorldInitializationAgentWithWorkspace(workspace)
  try {
    console.log(`读取视图：${workspace.viewRoot}`)
    console.log(`草稿目录：${workspace.draftRoot}`)
    console.log(`已确认资料目录：${workspace.confirmedRoot}`)
    const input = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
    try { await runFileDebugSession(agent, input, text => console.log(text)) }
    finally { input.close() }
  } finally { await agent.dispose() }
}

if (require.main === module) {
  void debugWorldInitializationFiles().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
