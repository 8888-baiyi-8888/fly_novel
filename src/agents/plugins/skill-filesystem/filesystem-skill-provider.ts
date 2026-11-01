import { open, realpath, readdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'
import type { SkillDefinition, SkillProvider, SkillSummary } from '@fly-novel/skill'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SKILL_BYTES = 1024 * 1024

/** 从可信来源加载同名目录下的 SKILL.md；来源必须处于授权工作目录内。 */
export class FilesystemSkillProvider implements SkillProvider {
  readonly name = 'filesystem'
  private readonly root: string

  /** @param root 由可信调用方指定的 Skill 根目录，必须为绝对路径。 */
  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error('Skill 根目录必须是绝对路径')
    this.root = resolve(root)
  }

  /** 查询 Skill 摘要；没有 SKILL.md 的目录被忽略，格式和访问错误会抛出。 */
  async list(workingDirectory: string, signal: AbortSignal): Promise<readonly SkillSummary[]> {
    signal.throwIfAborted()
    const workspace = await realpath(workingDirectory)
    const root = await realpath(this.root)
    if (!inside(workspace, root)) throw new Error('Skill 根目录超出授权工作目录')
    const entries = await readdir(root, { withFileTypes: true })
    const summaries: SkillSummary[] = []
    for (const entry of entries) {
      signal.throwIfAborted()
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || !SKILL_NAME.test(entry.name)) continue
      try {
        const skill = await this.read(entry.name, workingDirectory, signal, true)
        summaries.push({ name: entry.name, description: skill.description, invocation: skill.invocation, provider: this.name })
      } catch (error) {
        if (error instanceof Error && error.message === `Skill "${entry.name}" 不存在或不可用`) continue
        throw error
      }
    }
    return summaries.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * @param name Skill 的 kebab-case 名称。
   * @param workingDirectory 可信调用方提供的授权工作目录。
   * @param signal 取消信号。
   * @returns Skill 正文及其资源目录。
   * @throws 名称、授权范围、元信息或文件内容无效，或读取失败时抛错。
   */
  async get(name: string, workingDirectory: string, signal: AbortSignal): Promise<SkillDefinition> {
    const skill = await this.read(name, workingDirectory, signal, false)
    if (skill.content === undefined) throw new Error('Skill 正文未加载')
    return { name, description: skill.description, invocation: skill.invocation, provider: this.name, resourceBase: { kind: 'directory', path: skill.directory }, content: skill.content }
  }

  private async read(name: string, workingDirectory: string, signal: AbortSignal, summaryOnly: boolean): Promise<{
    directory: string; description: string; invocation: SkillSummary['invocation']; content?: string
  }> {
    signal.throwIfAborted()
    if (!SKILL_NAME.test(name)) throw new Error('Skill 名称必须使用小写字母、数字和连字符')
    const workspace = await realpath(workingDirectory)
    const root = await realpath(this.root)
    if (!inside(workspace, root)) throw new Error('Skill 根目录超出授权工作目录')

    let directory: string
    let filePath: string
    try {
      directory = await realpath(join(root, name))
      if (!inside(root, directory)) throw new Error('Skill 目录超出授权范围')
      filePath = await realpath(join(directory, 'SKILL.md'))
      if (!inside(directory, filePath)) throw new Error('Skill 文件超出授权范围')
    } catch (error) {
      if (isMissing(error)) throw new Error(`Skill "${name}" 不存在或不可用`)
      throw error
    }
    signal.throwIfAborted()
    const file = await open(filePath, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error('Skill 文件必须是普通文件')
      if (summaryOnly) {
        const frontmatter = await readFrontmatter(file, signal)
        return { directory, ...parseMetadata(name, frontmatter) }
      }
      if (stat.size > MAX_SKILL_BYTES) throw new Error('Skill 文件超过 1 MiB 限制')
      const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        signal.throwIfAborted()
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > MAX_SKILL_BYTES) throw new Error('Skill 文件超过 1 MiB 限制')
      signal.throwIfAborted()
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
      const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
      if (!frontmatter) throw new Error('Skill 必须包含 YAML frontmatter')
      const content = text.slice(frontmatter[0].length).trim()
      if (!content) throw new Error('Skill 正文不能为空')
      return { directory, ...parseMetadata(name, frontmatter[1]!), content }
    } finally {
      await file.close()
    }
  }
}

/** 分块读取至元信息结束行；最多预读当前块中少量正文，不解析正文。 */
async function readFrontmatter(file: FileHandle, signal: AbortSignal): Promise<string> {
  const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1)
  let length = 0
  while (length < buffer.length) {
    signal.throwIfAborted()
    const { bytesRead } = await file.read(buffer, length, Math.min(4096, buffer.length - length), length)
    length += bytesRead
    const prefix = buffer.subarray(0, length).toString('latin1')
    const match = /^(?:\xef\xbb\xbf)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(prefix)
    // 块末尾的 --- 可能只是更长的一行，必须读到下一字节或文件结尾。
    if (match && (match[0].length < length || bytesRead === 0 || match[0].endsWith('\n'))) {
      const end = match[0].length
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end))
      const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(decoded)
      if (!frontmatter) throw new Error('Skill 必须包含 YAML frontmatter')
      return frontmatter[1]!
    }
    if (bytesRead === 0) throw new Error('Skill 必须包含 YAML frontmatter')
  }
  throw new Error('Skill 元信息超过 1 MiB 限制')
}

function parseMetadata(name: string, frontmatter: string): { description: string; invocation: SkillSummary['invocation'] } {
  const document = parseDocument(frontmatter, { uniqueKeys: true })
  if (document.errors.length > 0) throw new Error('Skill YAML frontmatter 无效')
  let metadata: unknown
  try {
    metadata = document.toJS({ maxAliasCount: 0 })
  } catch {
    throw new Error('Skill YAML frontmatter 无效')
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new Error('Skill 元信息必须是对象')
  }
  const fields = Object.fromEntries(Object.entries(metadata))
  if (fields.name !== name || typeof fields.description !== 'string' || !fields.description.trim()) {
    throw new Error('Skill 名称必须与目录一致且 description 不能为空')
  }
  const modelInvocable = fields['disable-model-invocation'] === undefined || !parseBoolean(fields['disable-model-invocation'])
  const userInvocable = fields['user-invocable'] === undefined || parseBoolean(fields['user-invocable'])
  return { description: fields.description, invocation: { modelInvocable, userInvocable } }
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': case '1': return true
      case 'false': case 'no': case 'off': case '0': return false
    }
  }
  throw new Error('Skill 调用权限必须是有效布尔值')
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
