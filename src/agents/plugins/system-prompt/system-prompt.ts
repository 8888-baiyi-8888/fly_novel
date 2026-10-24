/** 保存并读取一份静态系统提示词。 */
export interface PromptSection {
  /** 在当前 SystemPrompt 中唯一的名称。 */
  readonly name: string
  /** 后续组装阶段用于确定提示词段顺序。 */
  readonly order: number
  /** 当前阶段支持的固定文本。 */
  readonly text: string
}

/** 保存系统提示词，并注册可独立管理的静态提示词段。 */
export class SystemPrompt {
  private prompt = ''
  private readonly sections = new Map<string, PromptSection>()

  /** 替换当前保存的系统提示词。 */
  setPrompt(prompt: string): void {
    this.prompt = prompt
  }

  /** 返回当前系统提示词；尚未设置时返回空字符串。 */
  getPrompt(): string {
    return this.prompt
  }

  /** 注册提示词段；返回的函数可注销该次注册。 */
  section(section: PromptSection): () => void {
    const { name, order, text } = section
    if (!name.trim()) throw new Error('PromptSection name 不能为空')
    if (!Number.isFinite(order)) throw new TypeError(`PromptSection "${name}" order 必须是有限数值`)
    if (this.sections.has(name)) throw new Error(`PromptSection "${name}" 已注册`)

    const registered = Object.freeze({ name, order, text })
    this.sections.set(name, registered)
    return () => {
      if (this.sections.get(name) === registered) this.sections.delete(name)
    }
  }

  /** 按名称读取已注册提示词段；不存在时返回 undefined。 */
  getSection(name: string): PromptSection | undefined {
    return this.sections.get(name)
  }

  /** 返回当前提示词段的快照，顺序为注册顺序。 */
  listSections(): readonly PromptSection[] {
    return [...this.sections.values()]
  }
}
