import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { defineTool } from '../../agents/plugins/tools/index.js'

const MAX_BYTES = 1024 * 1024

/** 读取授权工作目录内的 UTF-8 普通文件，最大 1 MiB。 */
export const readFileTool = defineTool({
  name: 'read_file',
  description: '读取授权工作目录内的 UTF-8 文本文件',
  parameters: {
    path: { type: 'string', required: true, description: '相对于工作目录的文件路径' },
  },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    if (!args.path || isAbsolute(args.path)) {
      throw new Error('path 必须是非空相对路径')
    }
    const root = await realpath(exec.workingDirectory)
    const requested = resolve(root, args.path)
    if (!inside(root, requested)) throw new Error(`文件路径超出授权工作目录：${root}`)
    const target = await realpath(requested)
    if (!inside(root, target)) throw new Error(`文件路径超出授权工作目录：${root}`)
    const file = await open(target, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error('目标不是普通文件')
      if (stat.size > MAX_BYTES) throw new Error('文件超过 1 MiB 限制')
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        exec.signal.throwIfAborted()
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > MAX_BYTES) throw new Error('文件超过 1 MiB 限制')
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
    } finally {
      await file.close()
    }
  },
})

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}
