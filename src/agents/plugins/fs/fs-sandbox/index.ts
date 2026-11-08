import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@fly-novel/fs'
import type { FsDeleteOutcome, FsEditOutcome, FsEditRequest, FsMoveOutcome, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@fly-novel/fs'
import { LocalFileSystem } from '@fly-novel/fs-local'
import type { Config } from '@fly-novel/fs-local'
import { writableRoots } from '@fly-novel/sandbox'
import type {} from '@fly-novel/sandbox-policy'
import type { PatchHunk } from '@fly-novel/fs-patch'
import { isPathUnder } from './containment.js'

/** 仅限制修改的本机后端；读取仍须由调用方另行授权。 */
export class SandboxedFileSystem extends LocalFileSystem {
  static inject = ['sandboxPolicy']
  private closing = false
  private readonly pending = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    ctx.effect(() => async () => {
      this.closing = true
      await Promise.allSettled([...this.pending])
    })
  }

  private async mutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error('文件沙箱已销毁')
    const pending = operation()
    this.pending.add(pending)
    try { return await pending } finally { this.pending.delete(pending) }
  }

  private async checkedTarget(target: FsTarget): Promise<FsTarget> {
    const policy = this.ctx.sandboxPolicy.resolve()
    if (policy.mode === 'danger-full-access') return target
    if (policy.mode === 'read-only') throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    const fresh = await this.resolve(target.displayPath)
    for (const root of writableRoots(policy)) {
      if (await isPathUnder(fresh.targetKey, root)) return fresh
    }
    throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    return this.mutation(async () => super.writeText(await this.checkedTarget(target), content, expected, signal))
  }
  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    return this.mutation(async () => super.editText(await this.checkedTarget(target), edit, expected, signal))
  }
  override async patchText(target: FsTarget, hunks: readonly PatchHunk[], expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    return this.mutation(async () => super.patchText(await this.checkedTarget(target), hunks, expected, signal))
  }
  override async deleteFile(target: FsTarget, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsDeleteOutcome> {
    return this.mutation(async () => super.deleteFile(await this.checkedTarget(target), expected, signal))
  }
  override async moveFile(source: FsTarget, destination: FsTarget, options: Parameters<LocalFileSystem['moveFile']>[2], signal?: AbortSignal): Promise<FsMoveOutcome> {
    return this.mutation(async () => {
      const checkedSource = await this.checkedTarget(source)
      const checkedDestination = await this.checkedTarget(destination)
      return super.moveFile(checkedSource, checkedDestination, options, signal)
    })
  }
}

/** 显式装配为当前 Agent 的唯一文件后端；依赖策略随作用域提供。 */
export const fsSandboxPlugin = Object.assign(async function fsSandboxPlugin(ctx: Context, config: Config = {}): Promise<void> {
  await ctx.plugin(SandboxedFileSystem, config)
}, { inject: ['sandboxPolicy'], provide: 'fs' })

export const fsSandboxPluginDefinition = {
  id: 'fs-sandbox', version: '1.0.0', description: '限制本机文件修改范围', plugin: fsSandboxPlugin,
}
