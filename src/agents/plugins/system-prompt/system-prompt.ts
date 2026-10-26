/** 注册时保存的静态系统提示词段。 */
export interface PromptSection {
  /** 在当前 SystemPrompt 中唯一的名称。 */
  readonly name: string
  /** 后续组装阶段用于确定提示词段顺序。 */
  readonly order: number
  /** 当前阶段支持的固定文本。 */
  readonly text: string
}

/** 已排序的提示词段快照。 */
export interface PromptAssembly {
  readonly sections: readonly PromptSection[]
}

/** 保存并组装可独立管理的静态提示词段。 */
export class SystemPrompt {
  private readonly sections = new Map<string, PromptSection>()

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

  /** 按顺序值和名称排序，生成独立于注册表的静态组装快照。 */
  assemble(): PromptAssembly {
    const sections = [...this.sections.values()]
      .sort((left, right) => left.order - right.order || compareNames(left.name, right.name))
    return { sections }
  }
}

/** 过滤空段并以空行连接提示词文本。 */
export function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map((section) => section.text)
    .filter((text) => text.length > 0)
    .join('\n\n')
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
