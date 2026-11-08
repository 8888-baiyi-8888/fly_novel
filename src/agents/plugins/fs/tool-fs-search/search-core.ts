import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/fs'
import type {} from '@fly-novel/subprocess'
import { resolveReadTarget } from '@fly-novel/tool-fs'
import { deadline, timeoutOf } from '@fly-novel/timeout'

export interface SearchLimits {
  timeoutMs: number
  graceMs: number
  rawOutputMaxBytes: number
  stderrMaxBytes: number
}

export interface SearchRun { stdout: string, noMatches: boolean, workdir: string }

/** 在可信读取视图中运行固定 ripgrep 命令；调用方负责构造不含目标路径的参数。 */
export async function runSearch(ctx: Context, workingDirectory: string, targetPath: string, args: readonly string[], limits: SearchLimits, signal: AbortSignal): Promise<SearchRun> {
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('搜索限制无效')
  const limit = deadline(signal, limits.timeoutMs, 'SEARCH_TIMEOUT')
  try {
    const root = await resolveReadTarget(ctx.fs, workingDirectory, '.', limit.signal)
    const target = await resolveReadTarget(ctx.fs, workingDirectory, targetPath, limit.signal)
    const workdir = ctx.fs.processPath(root)
    const path = ctx.fs.processPath(target)
    const { handle, outcome } = await (async () => {
      try {
        const { rgPath } = await import('@vscode/ripgrep')
        limit.signal.throwIfAborted()
        const handle = ctx.subprocess.spawn({
          argv: [rgPath, '--no-config', ...args, '--', path], cwd: workdir,
          stdio: { stdin: 'ignore', stdout: { maxBytes: limits.rawOutputMaxBytes }, stderr: { maxBytes: limits.stderrMaxBytes } },
          graceMs: limits.graceMs, signal: limit.signal,
        })
        return { handle, outcome: await handle.done }
      } catch (error) {
        throw new Error('搜索进程无法执行', { cause: error })
      }
    })()
    if (limit.signal.aborted) throw new Error(timeoutOf(limit.signal, 'SEARCH_TIMEOUT') ? '搜索超时' : '搜索已取消')
    if (outcome.signal !== null || outcome.exitCode === null || (outcome.exitCode !== 0 && outcome.exitCode !== 1)) {
      const diagnostics = handle.collected.stderr.readFrom(0).text
      if (/regex parse error|error parsing glob/i.test(diagnostics)) throw new Error('搜索模式无效')
      throw new Error('搜索执行失败')
    }
    const output = handle.collected.stdout.readFrom(0)
    if (output.lossy) throw new Error('搜索原始结果超过输出上限')
    return { stdout: output.text, noMatches: outcome.exitCode === 1, workdir }
  } catch (error) {
    if (limit.signal.aborted) throw new Error(timeoutOf(limit.signal, 'SEARCH_TIMEOUT') ? '搜索超时' : '搜索已取消', { cause: error })
    throw error
  } finally {
    limit[Symbol.dispose]()
  }
}
