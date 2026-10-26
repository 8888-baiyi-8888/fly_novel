/** 一次组装时可用于计算提示词段的调用上下文。 */
export interface AssembleContext {
  readonly [key: string]: unknown
}

export type PromptTextProvider = (context: AssembleContext) => string

/** 注册时保存的静态或动态系统提示词段。 */
export interface PromptSection {
  /** 在当前 SystemPrompt 中唯一的名称。 */
  readonly name: string
  /** 后续组装阶段用于确定提示词段顺序。 */
  readonly order: number
  /** 固定文本或在每次组装时调用的文本提供函数。 */
  readonly text: string | PromptTextProvider
  /** 是否在渲染时解析变量；默认解析。 */
  readonly interpolate?: boolean
}

export interface AssembledSection {
  readonly name: string
  readonly text: string
  readonly interpolate?: boolean
}

/** 已排序并完成动态文本求值的提示词快照。 */
export interface PromptAssembly {
  readonly sections: readonly AssembledSection[]
  readonly variables: Readonly<Record<string, string | undefined>>
}

export type PromptVariableProvider = (context: AssembleContext) => string | undefined

const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** 保存并组装可独立管理的提示词段与变量。 */
export class SystemPrompt {
  private readonly sections = new Map<string, PromptSection>()
  private readonly variables = new Map<string, PromptVariableProvider>()

  /** 注册提示词段；返回的函数可注销该次注册。 */
  section(section: PromptSection): () => void {
    const { name, order, text } = section
    if (!name.trim()) throw new Error('PromptSection name 不能为空')
    if (!Number.isFinite(order)) throw new TypeError(`PromptSection "${name}" order 必须是有限数值`)
    if (this.sections.has(name)) throw new Error(`PromptSection "${name}" 已注册`)

    const registered = Object.freeze({
      name,
      order,
      text,
      ...(section.interpolate !== undefined ? { interpolate: section.interpolate } : {}),
    })
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

  /** 注册一个提示词变量提供函数；返回的函数可注销该次注册。 */
  variable(name: string, provider: PromptVariableProvider): () => void {
    if (!VARIABLE_NAME.test(name)) throw new Error(`Prompt variable 名称无效: "${name}"`)
    if (this.variables.has(name)) throw new Error(`Prompt variable "${name}" 已注册`)

    this.variables.set(name, provider)
    return () => {
      if (this.variables.get(name) === provider) this.variables.delete(name)
    }
  }

  /** 求值动态文本和变量提供函数，并生成有序的组装快照。 */
  assemble(context: AssembleContext = {}): PromptAssembly {
    const variables: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>
    for (const [name, provider] of this.variables) variables[name] = provider(context)

    const sections = [...this.sections.values()]
      .sort((left, right) => left.order - right.order || compareNames(left.name, right.name))
      .map((section): AssembledSection => ({
        name: section.name,
        text: typeof section.text === 'function' ? section.text(context) : section.text,
        ...(section.interpolate !== undefined ? { interpolate: section.interpolate } : {}),
      }))

    return Object.freeze({
      sections: Object.freeze(sections.map((section) => Object.freeze(section))),
      variables: Object.freeze(variables),
    })
  }
}

/** 插值变量、过滤空段并以空行连接提示词文本。 */
export function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections
    .map((section) => section.interpolate === false
      ? section.text
      : interpolate(section, assembly.variables))
    .filter((text) => text.length > 0)
    .join('\n\n')
}

function interpolate(section: AssembledSection, variables: Readonly<Record<string, string | undefined>>): string {
  const { text } = section
  let result = ''
  let last = 0

  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = /^\{\{([^{}]*)\}\}/.exec(text.slice(open))
    if (group === null) {
      if (text.indexOf('}}', open + 2) >= 0) {
        throw new Error(`提示词段 "${section.name}" 包含格式错误的变量引用`)
      }
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }

    const name = group[1]
    if (!VARIABLE_NAME.test(name)) throw new Error(`提示词段 "${section.name}" 包含无效变量 "{{${name}}}"`)
    if (!Object.hasOwn(variables, name)) throw new Error(`提示词段 "${section.name}" 引用了未注册变量 "${name}"`)
    const value = variables[name]
    if (value === undefined) throw new Error(`提示词变量 "${name}" 未提供值`)

    result += text.slice(last, open) + value
    last = open + group[0].length
  }

  return result + text.slice(last)
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
