import { Context, Service } from '@deepseek-ai/cordis'

/** 一次受管理的前台进程请求。命令及参数不会经过 Shell。 */
export interface SubprocessSpawnSpec {
  argv: readonly string[]
  cwd: string
  stdio: { stdin: 'ignore', stdout: { maxBytes: number }, stderr: { maxBytes: number } }
  graceMs: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

export interface SubprocessOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface SubprocessOutputRead {
  text: string
  nextOffset: number
  lossy: boolean
}

export interface SubprocessOutputReader {
  readFrom(fromByte: number): SubprocessOutputRead
}

/** 直接进程结果与提供方可观察的管理范围退出分别等待。 */
export interface SubprocessHandle {
  readonly collected: { stdout: SubprocessOutputReader, stderr: SubprocessOutputReader }
  readonly done: Promise<SubprocessOutcome>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context { subprocess: SubprocessRuntime }
}

/** 子进程服务由提供方显式注册；作用域销毁时提供方负责终止并等待其管理范围。 */
export abstract class SubprocessRuntime extends Service {
  constructor(ctx: Context) { super(ctx, 'subprocess') }
  abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

/** 继承环境时过滤常见凭据名称及上游保留的 DSH_ 名称。 */
export function scrubbedParentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/KEY|PASSWORD|SECRET|TOKEN/i.test(key) && !key.toUpperCase().startsWith('DSH_')) env[key] = value
  }
  return env
}
