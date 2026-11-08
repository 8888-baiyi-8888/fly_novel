import type { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@fly-novel/fs-sandbox'
import { defineTool } from '@fly-novel/tools'
import { executePatch } from './patch/index.js'
import type { PatchExecutionReport } from './patch/types.js'

function reportText(report: PatchExecutionReport): string {
  if (report.phase === 'syntax') return JSON.stringify({ phase: report.phase, failure: report.failure })
  if (report.phase === 'preflight') return JSON.stringify({ phase: report.phase, refusals: report.refusals })
  return JSON.stringify({ phase: report.phase, cancelled: report.cancelled, outcomes: report.outcomes.map(outcome => ({
    status: outcome.status, operation: outcome.operation,
    ...('failure' in outcome ? { failure: outcome.failure } : {}),
    ...('changes' in outcome ? { changedPaths: outcome.changes.map(change => change.path) } : {}),
  })) })
}

/** 显式注册多文件补丁工具，提交结果按顺序保留且不会自动回滚。 */
export const toolFsPatchPlugin = Object.assign(function toolFsPatchPlugin(ctx: Context): void {
  if (!(ctx.fs instanceof SandboxedFileSystem)) throw new Error('补丁工具必须装配沙箱文件后端')
  const tool = defineTool({
    name: 'apply_patch', description: '按顺序新增、修改、删除或移动文本文件；失败时报告已提交和未知结果。', reportOnAbort: true,
    parameters: { input: { type: 'string', required: true, description: '包含 Begin Patch 与 End Patch 的补丁文本' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) { return reportText(await executePatch(ctx, exec, { patch: args.input })) },
  })
  ctx.effect(() => ctx.tools.register(tool))
}, { inject: ['tools', 'fs'] })

export const toolFsPatchPluginDefinition = {
  id: 'tool-fs-patch', version: '1.0.0', description: '注册受授权约束的多文件补丁工具', plugin: toolFsPatchPlugin,
}
