import type { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@fly-novel/fs-sandbox'
import { defineTool } from '@fly-novel/tools'
import { resolveReadTarget } from './read-access.js'

/** 在受信任沙箱后端上注册文本写入和编辑工具。 */
export const toolFsMutationPlugin = Object.assign(function toolFsMutationPlugin(ctx: Context): void {
  if (!(ctx.fs instanceof SandboxedFileSystem)) throw new Error('文件修改工具必须装配沙箱文件后端')
  const write = defineTool({
    name: 'write', description: '创建或完整替换授权范围内的 UTF-8 文本文件。',
    parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', required: true }, operation: { type: 'string', enum: ['create', 'update'], required: true },
    } }, render: (_args, value) => [{ type: 'text', text: `${value.operation}: ${value.path}` }] },
    async execute(args, exec) {
      if (!args.file_path.trim()) throw new Error('file_path 必须非空')
      const target = await ctx.fs.resolve(args.file_path, { cwd: exec.workingDirectory, signal: exec.signal })
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      const outcome = await ctx.fs.writeText(target, args.content, intent, exec.signal)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return { path: target.displayPath, operation: outcome.operation }
    },
  })
  const edit = defineTool({
    name: 'edit', description: '替换授权文本文件中的字面文本。',
    parameters: {
      file_path: { type: 'string', required: true }, old_string: { type: 'string', required: true },
      new_string: { type: 'string', required: true }, replace_all: { type: 'boolean' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `edited: ${value.path}` }] },
    async execute(args, exec) {
      if (!args.old_string) throw new Error('old_string 必须非空')
      const target = await resolveReadTarget(ctx.fs, exec.workingDirectory, args.file_path, exec.signal)
      const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
      const outcome = await ctx.fs.editText(target, { oldString: args.old_string, newString: args.new_string, replaceAll: args.replace_all ?? false }, intent, exec.signal)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return { path: target.displayPath }
    },
  })
  ctx.effect(() => {
    const unregisterWrite = ctx.tools.register(write)
    try {
      const unregisterEdit = ctx.tools.register(edit)
      return () => { unregisterEdit(); unregisterWrite() }
    } catch (error) { unregisterWrite(); throw error }
  })
}, { inject: ['tools', 'fs'] })

export const toolFsMutationPluginDefinition = {
  id: 'tool-fs-mutation', version: '1.0.0', description: '注册受沙箱约束的文本修改工具', plugin: toolFsMutationPlugin,
}
