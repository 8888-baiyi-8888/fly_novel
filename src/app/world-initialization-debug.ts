import { createInterface } from 'node:readline'
import { createWorldInitializationAgent } from './agents/index.js'

/** 使用本地模型配置与仓库示例 Skill，在同一实例内进行终端调试。 */
export async function debugWorldInitialization(): Promise<void> {
  const agent = await createWorldInitializationAgent()
  try {
    const input = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
    try {
      console.log('世界初始化主 Agent 调试已启动。输入 /exit 结束。')
      input.setPrompt('你> ')
      input.prompt()
      for await (const line of input) {
        const prompt = line.trim()
        if (prompt === '/exit') break
        if (prompt) console.log('Agent>', (await agent.run({ prompt })).content)
        input.prompt()
      }
    } finally {
      input.close()
    }
  } finally {
    await agent.dispose()
  }
}

if (require.main === module) {
  void debugWorldInitialization().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
