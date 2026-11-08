import type { Context } from '@deepseek-ai/cordis'
import { FsError, type FsDeleteOutcome, type FsEditOutcome, type FsEditRequest, type FsMoveOutcome, type FsTarget, type FsVersion, type FsWriteIntent, type FsWriteOutcome } from '@fly-novel/fs'
import { SandboxedFileSystem, isPathUnder } from '@fly-novel/fs-sandbox'
import type { Config } from '@fly-novel/fs-local'

interface DraftFsConfig extends Config { draftRoot: string }

/** 在上游文件沙箱之外，将本应用的修改进一步限制在草稿目录。 */
export class WorldInitializationDraftFileSystem extends SandboxedFileSystem {
  private readonly draftRoot: string
  constructor(ctx: Context, config: DraftFsConfig) {
    super(ctx, config)
    this.draftRoot = config.draftRoot
  }

  private async draftTarget(target: FsTarget): Promise<FsTarget> {
    const fresh = await this.resolve(target.displayPath)
    if (fresh.targetKey !== target.targetKey) throw new FsError('修改目标身份已变化，请重新解析', 'FS_STALE_VERSION')
    if (!await isPathUnder(fresh.targetKey, this.draftRoot)) throw new FsError('只允许修改草稿目录', 'FS_SANDBOX_DENIED')
    return fresh
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    return super.writeText(await this.draftTarget(target), content, expected, signal)
  }
  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    return super.editText(await this.draftTarget(target), edit, expected, signal)
  }
  override async patchText(target: FsTarget, hunks: Parameters<SandboxedFileSystem['patchText']>[1], expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    return super.patchText(await this.draftTarget(target), hunks, expected, signal)
  }
  override async deleteFile(target: FsTarget, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsDeleteOutcome> {
    return super.deleteFile(await this.draftTarget(target), expected, signal)
  }
  override async moveFile(source: FsTarget, destination: FsTarget, options: Parameters<SandboxedFileSystem['moveFile']>[2], signal?: AbortSignal): Promise<FsMoveOutcome> {
    return super.moveFile(await this.draftTarget(source), await this.draftTarget(destination), options, signal)
  }
}

export const worldInitializationDraftFsPlugin = Object.assign(async (ctx: Context, config: DraftFsConfig): Promise<void> => {
  await ctx.plugin(WorldInitializationDraftFileSystem, config)
}, { inject: ['sandboxPolicy'], provide: 'fs' as const })

export const worldInitializationDraftFsPluginDefinition = {
  id: 'world-initialization-draft-fs', version: '1.0.0', description: '限制世界初始化修改到草稿目录', plugin: worldInitializationDraftFsPlugin,
}
