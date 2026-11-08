import { spawn, spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, scrubbedParentEnv, type SubprocessHandle, type SubprocessOutcome, type SubprocessOutputRead, type SubprocessOutputReader, type SubprocessSpawnSpec } from '@fly-novel/subprocess'

const MAX_TIMER_DELAY_MS = 2_147_483_647

class OutputTail implements SubprocessOutputReader {
  private data: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private total = 0
  constructor(private readonly maxBytes: number) {}
  append(chunk: Buffer): void {
    this.total += chunk.length
    this.data = chunk.length >= this.maxBytes
      ? Buffer.from(chunk.subarray(chunk.length - this.maxBytes))
      : Buffer.concat([this.data.subarray(Math.max(0, this.data.length + chunk.length - this.maxBytes)), chunk])
  }
  readFrom(fromByte: number): SubprocessOutputRead {
    if (!Number.isSafeInteger(fromByte) || fromByte < 0 || fromByte > this.total) throw new RangeError('输出偏移无效')
    const start = this.total - this.data.length
    return { text: this.data.subarray(Math.max(0, fromByte - start)).toString('utf8'), nextOffset: this.total, lossy: fromByte < start }
  }
}

function childEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = scrubbedParentEnv()
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (process.platform === 'win32') {
      for (const old of Object.keys(env)) if (old.toUpperCase() === key.toUpperCase()) delete env[old]
    }
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

function validate(spec: SubprocessSpawnSpec): void {
  if (!spec.argv.length || !spec.argv[0] || spec.argv.some(arg => arg.includes('\0'))) throw new Error('子进程 argv 无效')
  if (!isAbsolute(spec.cwd)) throw new Error('子进程工作目录必须为绝对路径')
  if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) throw new Error('子进程宽限期无效')
  for (const limit of [spec.stdio.stdout.maxBytes, spec.stdio.stderr.maxBytes]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('子进程输出上限无效')
  }
  spec.signal?.throwIfAborted()
}

/** 本机回退提供方：POSIX 进程组或 Windows 可观察进程树。 */
export class LocalSubprocessRuntime extends SubprocessRuntime {
  private readonly live = new Set<SubprocessHandle>()
  private closing = false
  private closingPromise?: Promise<void>

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => () => this.dispose(), 'local subprocess teardown')
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.closing) throw new Error('子进程服务已关闭')
    validate(spec)
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
      cwd: spec.cwd, env: childEnvironment(spec.env), shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    })
    const stdout = new OutputTail(spec.stdio.stdout.maxBytes)
    const stderr = new OutputTail(spec.stdio.stderr.maxBytes)
    child.stdout!.on('data', (chunk: Buffer) => stdout.append(chunk))
    child.stderr!.on('data', (chunk: Buffer) => stderr.append(chunk))
    let exited = false
    let terminated = false
    let retired = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    let resolveDone!: (value: SubprocessOutcome) => void
    let rejectDone!: (error: Error) => void
    const done = new Promise<SubprocessOutcome>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
    // A caller may start disposal before it has attached its own rejection handler.
    void done.catch(() => {})
    let exitOutcome: SubprocessOutcome | undefined
    let settled = false
    const settle = (outcome?: SubprocessOutcome, error?: Error): void => {
      if (settled) return
      settled = true
      if (drainTimer !== undefined) clearTimeout(drainTimer)
      if (error) rejectDone(error)
      else resolveDone(outcome!)
    }
    child.once('error', error => { exited = true; settle(undefined, error) })
    child.once('exit', (exitCode, signal) => {
      exited = true
      exitOutcome = { exitCode, signal }
      drainTimer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); settle(exitOutcome) }, spec.graceMs)
    })
    child.once('close', (exitCode, signal) => { exited = true; settle(exitOutcome ?? { exitCode, signal }) })

    const alive = (): boolean => {
      if (retired) return false
      if (child.pid === undefined) return false
      if (process.platform === 'win32') return !exited
      try { process.kill(-child.pid, 0); return true } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        throw error
      }
    }
    const send = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      if (process.platform === 'win32') {
        if (!exited) {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          // taskkill can fail without a spawn error; still terminate the direct child.
          child.kill('SIGKILL')
        }
      } else {
        try { process.kill(-child.pid, signal) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
    }
    const terminate = (): void => {
      if (terminated) return
      terminated = true
      if (alive()) {
        send('SIGTERM')
        if (process.platform !== 'win32') killTimer = setTimeout(() => { if (alive()) send('SIGKILL') }, spec.graceMs)
      }
    }
    const onAbort = (): void => { terminate() }
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    if (spec.signal?.aborted) terminate()
    const wait = async (signal?: AbortSignal): Promise<boolean> => {
      while (alive()) {
        if (signal?.aborted) return false
        await new Promise<void>(resolve => setTimeout(resolve, 15))
      }
      retired = true
      return !signal?.aborted
    }
    const handle: SubprocessHandle = { collected: { stdout, stderr }, done, terminate, waitForExit: wait }
    this.live.add(handle)
    const release = async (): Promise<void> => {
      try { await wait() } finally {
        if (killTimer !== undefined) clearTimeout(killTimer)
        spec.signal?.removeEventListener('abort', onAbort)
        this.live.delete(handle)
      }
    }
    void done.then(release, release).catch(() => {})
    return handle
  }

  dispose(): Promise<void> {
    if (this.closingPromise) return this.closingPromise
    this.closing = true
    this.closingPromise = (async () => {
      const handles = [...this.live]
      for (const handle of handles) handle.terminate()
      await Promise.all(handles.map(async handle => { await Promise.all([handle.done.catch(() => {}), handle.waitForExit()]) }))
    })()
    return this.closingPromise
  }
}

export const localSubprocessPlugin = Object.assign(async (ctx: Context): Promise<void> => {
  await ctx.plugin(LocalSubprocessRuntime)
}, { provide: 'subprocess' as const })

export const localSubprocessPluginDefinition = {
  id: 'subprocess-local', version: '1.0.0', description: '提供本机前台子进程', plugin: localSubprocessPlugin,
}
