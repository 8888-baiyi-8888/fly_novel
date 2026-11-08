import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@fly-novel/fs'
import { defineTool } from '@fly-novel/tools'
import { resolveReadTarget } from './read-access.js'
import { buildWindow, formatReadOutput, READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from './read-render.js'

const READ_LIMIT = 2000

/** 显式注册读取工具，使用可信工作目录约束读取范围。 */
export const toolFsReadPlugin = Object.assign(function toolFsReadPlugin(ctx: Context): void {
  const tool = defineTool({
    name: 'read',
    description: '读取授权目录内的 UTF-8 文本并返回带行号的内容。',
    parameters: {
      file_path: { type: 'string', required: true, description: '文件路径' },
      offset: { type: 'number', description: '从 1 开始的行号' },
      limit: { type: 'number', description: '最大返回行数' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, offset: { type: 'integer', required: true },
        totalLines: { type: 'integer', required: true }, truncatedByBytes: { type: 'boolean', required: true },
        lines: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          number: { type: 'integer', required: true }, text: { type: 'string', required: true },
        } } },
      } },
      render(_args, value) {
        return [{ type: 'text', text: formatReadOutput(value.path, { offset: value.offset, lines: value.lines, totalLines: value.totalLines, ...(value.truncatedByBytes ? { truncatedByBytes: true as const } : {}) }) }]
      },
    },
    async execute(args, exec) {
      const offset = args.offset ?? 1
      const limit = args.limit ?? READ_LIMIT
      if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > READ_LIMIT) throw new Error('offset 和 limit 必须为正整数，limit 不得超过 2000')
      const target = await resolveReadTarget(ctx.fs, exec.workingDirectory, args.file_path, exec.signal)
      const before = await ctx.fs.stat(target, exec.signal)
      if (!before) {
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        throw new FsError('读取目标不存在', 'FS_NOT_FOUND')
      }
      if (before.type !== 'file') throw new FsError('读取目标不是普通文件', 'FS_NOT_REGULAR_FILE')
      const chunks = await ctx.fs.streamText(target, exec.signal)
      const window = await buildWindow(chunks, { offset, limit, maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES }, target.displayPath)
      const after = await ctx.fs.stat(target, exec.signal)
      if (!after || after.type !== 'file' || after.version !== before.version) throw new FsError('文件在读取期间发生变化', 'FS_STALE_VERSION')
      ctx.emit('fs/observed', target, { kind: 'present', version: after.version }, exec)
      return { path: ctx.fs.processPath(target), offset, ...window }
    },
  })
  ctx.effect(() => ctx.tools.register(tool))
}, { inject: ['tools', 'fs'] })

export const toolFsReadPluginDefinition = {
  id: 'tool-fs-read', version: '1.0.0', description: '注册受读取范围约束的文本读取工具', plugin: toolFsReadPlugin,
}
