import { relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveReadTarget } from '@fly-novel/tool-fs'
import { defineTool } from '@fly-novel/tools'
import { runSearch, type SearchLimits } from './search-core.js'

export interface ToolFsSearchConfig {
  timeoutMs?: number
  graceMs?: number
  rawOutputMaxBytes?: number
  stderrMaxBytes?: number
  globMaxResults?: number
  grepMaxMatches?: number
  grepMaxLineBytes?: number
}

interface Match { path: string, lineNumber: number, line: string }
const vcs = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

function validateInclude(include: string): void {
  if (!include.trim() || include.startsWith('!')) throw new Error('include 必须是正向 glob')
  let depth = 0
  for (const character of include) {
    if (character === '{') depth++
    else if (character === '}') depth = Math.max(0, depth - 1)
    else if (character === ',' && depth === 0) throw new Error('include 只能包含一个 glob')
  }
}

function parseMatches(text: string): Match[] {
  const matches: Match[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let record: unknown
    try { record = JSON.parse(line) } catch { throw new Error('搜索结果格式无效') }
    if (typeof record !== 'object' || record === null) throw new Error('搜索结果格式无效')
    const item = record as { type?: unknown, data?: unknown }
    if (item.type !== 'match') continue
    if (typeof item.data !== 'object' || item.data === null) throw new Error('搜索结果格式无效')
    const data = item.data as { path?: { text?: unknown }, line_number?: unknown, lines?: { text?: unknown, bytes?: unknown } }
    if (typeof data.path?.text !== 'string' || !Number.isSafeInteger(data.line_number) || typeof data.line_number !== 'number' || data.line_number < 1) throw new Error('搜索结果路径或行号无效')
    const value = typeof data.lines?.text === 'string' ? data.lines.text.replace(/\r?\n$/, '') : typeof data.lines?.bytes === 'string' ? '(行内容不是有效 UTF-8)' : undefined
    if (value === undefined) throw new Error('搜索结果内容无效')
    matches.push({ path: data.path.text, lineNumber: data.line_number, line: value })
  }
  return matches
}

function preview(line: string, maxBytes: number): string {
  if (Buffer.byteLength(line) <= maxBytes) return line
  let length = 0; let text = ''
  for (const character of line) {
    length += Buffer.byteLength(character)
    if (length > maxBytes) break
    text += character
  }
  return `${text}…`
}

async function checkedPath(ctx: Context, workdir: string, path: string, signal: AbortSignal): Promise<string> {
  const target = await resolveReadTarget(ctx.fs, workdir, path, signal)
  const info = await ctx.fs.stat(target, signal)
  if (!info || info.type !== 'file') throw new Error('搜索结果已变化或不是普通文件')
  return relative(workdir, ctx.fs.processPath(target)) || '.'
}

/** 在当前 Agent 作用域注册文件搜索工具。 */
export const toolFsSearchPlugin = Object.assign(function toolFsSearchPlugin(ctx: Context, config: ToolFsSearchConfig = {}): void {
  const resolved = { timeoutMs: config.timeoutMs ?? 30_000, graceMs: config.graceMs ?? 3_000, rawOutputMaxBytes: config.rawOutputMaxBytes ?? 20_000_000, stderrMaxBytes: config.stderrMaxBytes ?? 65_536, globMaxResults: config.globMaxResults ?? 100, grepMaxMatches: config.grepMaxMatches ?? 250, grepMaxLineBytes: config.grepMaxLineBytes ?? 2_000 }
  for (const value of Object.values(resolved)) if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('搜索配置无效')
  const limits: SearchLimits = resolved
  const glob = defineTool({
    name: 'glob', description: '在授权目录中按 glob 模式查找文件。',
    parameters: { pattern: { type: 'string', required: true }, path: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { paths: { type: 'array', required: true, items: { type: 'string' } }, total: { type: 'integer', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.total ? `${value.paths.join('\n')}${value.total > value.paths.length ? `\n（显示 ${value.paths.length}/${value.total}，请缩小范围）` : ''}` : '未找到文件' }] },
    async execute(args, exec) {
      if (!args.pattern.trim() || (args.path !== undefined && !args.path.trim())) throw new Error('搜索模式和路径必须非空')
      const argv = ['--files', '--null', `--glob=${args.pattern}`, '--sort=modified', '--no-ignore', '--hidden', ...vcs.flatMap(name => [`--glob=!**/${name}`, `--glob=!**/${name}/**`])]
      const result = await runSearch(ctx, exec.workingDirectory, args.path ?? '.', argv, limits, exec.signal)
      const paths: string[] = []
      for (const path of result.stdout.split('\0')) if (path) paths.push(await checkedPath(ctx, result.workdir, path, exec.signal))
      return { paths: paths.slice(0, resolved.globMaxResults), total: paths.length }
    },
  })
  const grep = defineTool({
    name: 'grep', description: '在授权目录中按正则表达式搜索文件内容。',
    parameters: { pattern: { type: 'string', required: true }, path: { type: 'string' }, include: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { matches: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, lineNumber: { type: 'integer', required: true }, line: { type: 'string', required: true } } } }, total: { type: 'integer', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.total ? `${value.matches.map(m => `${m.path}:${m.lineNumber}: ${m.line}`).join('\n')}${value.total > value.matches.length ? `\n（显示 ${value.matches.length}/${value.total}，请缩小范围）` : ''}` : '未找到匹配' }] },
    async execute(args, exec) {
      if (!args.pattern || (args.path !== undefined && !args.path.trim())) throw new Error('搜索模式和路径必须非空')
      if (args.include) validateInclude(args.include)
      else if (args.include !== undefined && args.include !== '') validateInclude(args.include)
      const argv = ['--json', `--regexp=${args.pattern}`, ...(args.include ? [`--glob=${args.include}`] : [])]
      const result = await runSearch(ctx, exec.workingDirectory, args.path ?? '.', argv, limits, exec.signal)
      const matches = parseMatches(result.stdout)
      for (const match of matches) match.path = await checkedPath(ctx, result.workdir, match.path, exec.signal)
      return { matches: matches.slice(0, resolved.grepMaxMatches).map(m => ({ ...m, line: preview(m.line, resolved.grepMaxLineBytes) })), total: matches.length }
    },
  })
  ctx.effect(() => {
    const unregisterGlob = ctx.tools.register(glob)
    try { const unregisterGrep = ctx.tools.register(grep); return () => { unregisterGrep(); unregisterGlob() } }
    catch (error) { unregisterGlob(); throw error }
  })
}, { inject: ['tools', 'fs', 'subprocess'] })

export const toolFsSearchPluginDefinition = { id: 'tool-fs-search', version: '1.0.0', description: '注册授权文件搜索工具', plugin: toolFsSearchPlugin }
