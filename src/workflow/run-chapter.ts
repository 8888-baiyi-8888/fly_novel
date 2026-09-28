/**
 * 章节流驱动入口（示例/调试用，非库 API，不从 workflow/index 导出）。
 * 真实 OpenAI 兼容 agent（阿里云 MaaS / DashScope / DeepSeek 等）+ 模拟 Book Runtime
 * （FakeBookRuntime，fixtures 为 §7.7 实例）+ JSON 文件 store，端到端跑一章章节流。
 *
 * 用法（PowerShell，先编译）：
 *   npx tsc -p tsconfig.chapters.json
 *   $env:FLY_NOVEL_API_KEY='sk-xxxx'   # 或 --api-key
 *   node .test-dist/workflow/run-chapter.js --base-url https://xxx.maas.aliyuncs.com/compatible-mode/v1 --model qwen-plus
 * 可选参数：--book demo-book --chapter 1 --store-dir .fly-novel-store --temperature 0.7 --draft-file out/ch1.md
 * 小说流对接（N7 书目录 → BookRuntime）：--workspace <书目录路径> 替换默认 fixtures；
 *   --arch-file / --state0-file 可选补读 N5/N6 产物（角色卡 / 结构化角色状态），缺省自动在 artifacts 下定位。
 * 运行结束后：{store-dir}/{book}/<chapter>.json 即该章断点快照（settled 后内容完整）；
 * 正文草稿自动导出为 {store-dir}/{book}/<chapter>.md（--draft-file 可覆盖路径）。
 */
import type { BookId } from '../novel/types'
import { buildFakeBookRuntime } from '../novel/runtime'
import type { FakeBookRuntimeSnapshot } from '../novel/runtime'
import { buildRuntimeFromBookWorkspace } from '../novel/runtime/book-workspace.ts'
import { buildChapterNodes } from './nodes/index.ts'
import { ChapterWorkflow } from './engine.ts'
import { createJsonFileStore } from './file-store.ts'
import { createOpenAICompatibleAgent } from './openai-compatible-agent.ts'
import type { WorkflowEvent } from './types.ts'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface CliOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly book: BookId
  readonly chapter: number
  readonly storeDir: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly timeoutMs?: number
  /** 正文草稿导出路径；默认 {storeDir}/{book}/{chapter}.md。 */
  readonly draftFile?: string
  /** 运行时状态文件（账本/真相/时钟/角色状态的跨章持久化）；默认 {storeDir}/{book}/runtime-state.json。 */
  readonly runtimeState?: string
  /** 小说流 N7 书目录路径；提供后以其为 BookRuntime 唯一事实源（替换默认 fixtures）。 */
  readonly workspace?: string
  /** 可选：N5 architecture JSON 路径（角色卡/叙事线本体补源；缺省自动定位）。 */
  readonly architecturePath?: string
  /** 可选：N6 state0 JSON 路径（结构化角色状态补源；缺省自动定位）。 */
  readonly state0Path?: string
}

function parseArgs(argv: readonly string[]): Partial<CliOptions> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (key.startsWith('--') && i + 1 < argv.length) out[key.slice(2)] = argv[i + 1]
  }
  return {
    baseUrl: out['base-url'],
    apiKey: out['api-key'],
    model: out.model,
    book: out.book as BookId | undefined,
    chapter: out.chapter === undefined ? undefined : Number(out.chapter),
    storeDir: out['store-dir'],
    temperature: out.temperature === undefined ? undefined : Number(out.temperature),
    maxTokens: out['max-tokens'] === undefined ? undefined : Number(out['max-tokens']),
    timeoutMs: out.timeout === undefined ? undefined : Number(out.timeout),
    draftFile: out['draft-file'],
    runtimeState: out['runtime-state'],
    workspace: out.workspace,
    architecturePath: out['arch-file'],
    state0Path: out['state0-file'],
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2))
  const baseUrl = cli.baseUrl ?? process.env.FLY_NOVEL_BASE_URL
  const apiKey = cli.apiKey ?? process.env.FLY_NOVEL_API_KEY
  const model = cli.model ?? process.env.FLY_NOVEL_MODEL
  if (baseUrl === undefined || apiKey === undefined || model === undefined) {
    console.error('缺少参数：--base-url / --model（或环境变量 FLY_NOVEL_BASE_URL / FLY_NOVEL_MODEL）与 --api-key（或 FLY_NOVEL_API_KEY）')
    process.exit(1)
  }

  const book: BookId = (cli.book ?? 'demo-book') as BookId
  const chapter = cli.chapter ?? 1
  const storeDir = cli.storeDir ?? '.fly-novel-store'

  const agent = createOpenAICompatibleAgent({
    baseUrl,
    apiKey,
    model,
    temperature: cli.temperature,
    maxTokens: cli.maxTokens,
    timeoutMs: cli.timeoutMs ?? 480000,
  })
  const runtime = cli.workspace === undefined
    ? buildFakeBookRuntime()
    : buildRuntimeFromBookWorkspace(cli.workspace, {
        architecturePath: cli.architecturePath,
        state0Path: cli.state0Path,
      })
  const store = createJsonFileStore({ dir: storeDir })
  const runtimeStatePath = cli.runtimeState ?? join(storeDir, book, 'runtime-state.json')
  try {
    const raw = readFileSync(runtimeStatePath, 'utf8')
    runtime.restore(JSON.parse(raw) as FakeBookRuntimeSnapshot)
    console.log(`恢复运行时状态：${runtimeStatePath}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`运行时状态读取失败（${error instanceof Error ? error.message : String(error)}），使用默认 fixtures 继续`)
    }
  }
  const workflow = new ChapterWorkflow({
    nodes: buildChapterNodes(agent, { runtime }),
    store,
    maxRetries: 4,
    notify: (event: WorkflowEvent) => {
      switch (event.type) {
        case 'step-completed':
          console.log(`  [step] ${event.step} 完成（status=${event.state.status}）`)
          break
        case 'retrying':
          console.log(`  [retry] ${event.from} → ${event.to}（第 ${event.attempt} 次）`)
          break
        case 'suspended':
          console.log(`  [suspend] ${event.step}：${event.reason}`)
          break
        case 'failed':
          console.error(`  [fail] ${event.step}：${event.reason}`)
          break
        case 'completed':
          console.log(`  [done] 章 ${event.chapter} 完成（${event.state.status}）`)
          break
      }
    },
  })

  console.log(`运行章节流：book=${book} chapter=${chapter} model=${model}`)
  const result = await workflow.run(book, chapter)
  console.log(`结果：${result.kind}${result.kind === 'suspended' || result.kind === 'failed' ? `（${result.reason}）` : ''}`)
  // 只要有正文产物就导出草稿（completed / already-complete / suspended 均适用）。
  const persisted = await store.load(book, chapter)
  const draft = persisted?.artifacts?.['write']
  if (typeof draft === 'string' && draft !== '') {
    const draftPath = cli.draftFile ?? join(storeDir, book, `${chapter}.md`)
    mkdirSync(dirname(draftPath), { recursive: true })
    writeFileSync(draftPath, `# 第 ${chapter} 章\n\n${draft}`, 'utf8')
    console.log(`正文草稿：${draftPath}`)
  }
  if (result.kind === 'completed' || result.kind === 'already-complete') {
    const hooks = Object.entries(runtime.ledgerView)
      .filter(([, r]) => r.status !== 'open' || r.lastAdvancedChapter !== 0)
      .map(([id, r]) => `${id}:${r.status}`)
      .join(' ')
    console.log(`账本摘要：${hooks === '' ? '（无伏笔动作）' : hooks}`)
    console.log(`断点快照：${storeDir}/${book}/${chapter}.json`)
  }
  // 无论结果如何，落盘运行时状态（下一章从此继续）。
  try {
    mkdirSync(dirname(runtimeStatePath), { recursive: true })
    writeFileSync(runtimeStatePath, JSON.stringify(runtime.snapshot(), null, 2), 'utf8')
    console.log(`运行时状态：${runtimeStatePath}`)
  } catch (error) {
    console.warn(`运行时状态落盘失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

main().catch((error) => {
  console.error(`驱动失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
