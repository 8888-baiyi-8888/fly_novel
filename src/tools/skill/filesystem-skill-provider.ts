import { open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SKILL_BYTES = 1024 * 1024

export interface LoadedSkill {
  readonly name: string
  readonly provider: 'filesystem'
  readonly resourceBase: { readonly kind: 'directory'; readonly path: string }
  readonly content: string
}

/** 从可信来源加载同名目录下的 SKILL.md；来源必须处于授权工作目录内。 */
export class FilesystemSkillProvider {
  private readonly root: string

  /** @param root 由可信调用方指定的 Skill 根目录，必须为绝对路径。 */
  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error('Skill 根目录必须是绝对路径')
    this.root = resolve(root)
  }

  /**
   * @param name Skill 的 kebab-case 名称。
   * @param workingDirectory 可信调用方提供的授权工作目录。
   * @param signal 取消信号。
   * @returns Skill 正文及其资源目录。
   * @throws 名称、授权范围、元信息或文件内容无效，或读取失败时抛错。
   */
  async get(name: string, workingDirectory: string, signal: AbortSignal): Promise<LoadedSkill> {
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
      const content = parseSkill(name, text)
      return { name, provider: 'filesystem', resourceBase: { kind: 'directory', path: directory }, content }
    } finally {
      await file.close()
    }
  }
}

function parseSkill(name: string, text: string): string {
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!frontmatter) throw new Error('Skill 必须包含 YAML frontmatter')
  const document = parseDocument(frontmatter[1]!, { uniqueKeys: true })
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
  if (fields['disable-model-invocation'] !== undefined && parseBoolean(fields['disable-model-invocation'])) {
    throw new Error(`Skill "${name}" 不允许模型调用`)
  }
  if (fields['user-invocable'] !== undefined) parseBoolean(fields['user-invocable'])
  const content = text.slice(frontmatter[0].length).trim()
  if (!content) throw new Error('Skill 正文不能为空')
  return content
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
