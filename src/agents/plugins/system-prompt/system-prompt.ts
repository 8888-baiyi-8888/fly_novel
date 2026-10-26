/** 一次组装时可用于计算提示词段的调用上下文。 */
export interface AssembleContext {
  readonly [key: string]: unknown
  readonly scope?: string
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
  /** 设为 true 时，该段成为此作用域的完整提示词。 */
  readonly complete?: boolean
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

interface PromptLayer {
  readonly sections: Map<string, PromptSection>
  readonly variables: Map<string, PromptVariableEntry>
}

interface PromptVariableEntry {
  readonly provider: PromptVariableProvider
}

const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** 保存并组装可独立管理的提示词段与变量。 */
export class SystemPrompt {
  private readonly globalLayer = createLayer()
  private readonly scopedLayers = new Map<string, PromptLayer>()
  private disposed = false

  /** 注册提示词段；返回的函数可注销该次注册。 */
  section(section: PromptSection, scope?: string): () => void {
    this.assertOpen()
    const { name, order, text } = section
    if (!name.trim()) throw new Error('PromptSection name 不能为空')
    if (!Number.isFinite(order)) throw new TypeError(`PromptSection "${name}" order 必须是有限数值`)
    const layer = this.getLayer(scope, true)
    if (layer.sections.has(name)) throw new Error(`PromptSection "${name}" 已在当前作用域注册`)

    const registered = Object.freeze({
      name,
      order,
      text,
      ...(section.interpolate !== undefined ? { interpolate: section.interpolate } : {}),
      ...(section.complete !== undefined ? { complete: section.complete } : {}),
    })
    layer.sections.set(name, registered)
    return () => {
      if (layer.sections.get(name) !== registered) return
      layer.sections.delete(name)
      this.pruneLayer(scope, layer)
    }
  }

  /** 按名称读取已注册提示词段；不存在时返回 undefined。 */
  getSection(name: string, scope?: string): PromptSection | undefined {
    this.assertOpen()
    const scoped = scope === undefined ? undefined : this.getLayer(scope, false)?.sections.get(name)
    return scoped ?? this.globalLayer.sections.get(name)
  }

  /** 返回指定作用域可见的提示词段快照；同名作用域段覆盖全局段。 */
  listSections(scope?: string): readonly PromptSection[] {
    this.assertOpen()
    const merged = new Map(this.globalLayer.sections)
    if (scope !== undefined) {
      for (const [name, section] of this.getLayer(scope, false)?.sections ?? []) merged.set(name, section)
    }
    return [...merged.values()]
  }

  /** 注册一个提示词变量提供函数；返回的函数可注销该次注册。 */
  variable(name: string, provider: PromptVariableProvider, scope?: string): () => void {
    this.assertOpen()
    if (!VARIABLE_NAME.test(name)) throw new Error(`Prompt variable 名称无效: "${name}"`)
    const layer = this.getLayer(scope, true)
    if (layer.variables.has(name)) throw new Error(`Prompt variable "${name}" 已在当前作用域注册`)

    const entry = { provider }
    layer.variables.set(name, entry)
    return () => {
      if (layer.variables.get(name) !== entry) return
      layer.variables.delete(name)
      this.pruneLayer(scope, layer)
    }
  }

  /** 求值动态文本和变量提供函数，并生成有序的组装快照。 */
  assemble(context: AssembleContext = {}): PromptAssembly {
    this.assertOpen()
    const variables: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>
    const variableEntries = new Map(this.globalLayer.variables)
    for (const [name, entry] of this.getLayer(context.scope, false)?.variables ?? []) {
      variableEntries.set(name, entry)
    }
    for (const [name, entry] of variableEntries) variables[name] = entry.provider(context)

    const sectionDefinitions = new Map(this.globalLayer.sections)
    for (const [name, section] of this.getLayer(context.scope, false)?.sections ?? []) {
      sectionDefinitions.set(name, section)
    }
    const resolvedSections = [...sectionDefinitions.values()]
      .sort((left, right) => left.order - right.order || compareNames(left.name, right.name))
      .map((section): AssembledSection => ({
        name: section.name,
        text: typeof section.text === 'function' ? section.text(context) : section.text,
        ...(section.interpolate !== undefined ? { interpolate: section.interpolate } : {}),
      }))
    const completeSections = [...sectionDefinitions.values()].filter((section) => section.complete === true)
    if (completeSections.length > 1) {
      throw new Error(`多个完整提示词段同时生效: ${completeSections.map(({ name }) => `"${name}"`).join(', ')}`)
    }
    const sections = completeSections.length === 1
      ? resolvedSections.filter(({ name }) => name === completeSections[0].name)
      : resolvedSections

    return Object.freeze({
      sections: Object.freeze(sections.map((section) => Object.freeze(section))),
      variables: Object.freeze(variables),
    })
  }

  /** 释放所有注册内容并关闭对象；重复调用安全。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.globalLayer.sections.clear()
    this.globalLayer.variables.clear()
    this.scopedLayers.clear()
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('SystemPrompt 已销毁')
  }

  private getLayer(scope: string | undefined, create: true): PromptLayer
  private getLayer(scope: string | undefined, create: false): PromptLayer | undefined
  private getLayer(scope: string | undefined, create: boolean): PromptLayer | undefined {
    if (scope === undefined) return this.globalLayer
    if (!scope.trim()) throw new Error('Prompt scope 不能为空')
    const existing = this.scopedLayers.get(scope)
    if (existing || !create) return existing
    const layer = createLayer()
    this.scopedLayers.set(scope, layer)
    return layer
  }

  private pruneLayer(scope: string | undefined, layer: PromptLayer): void {
    if (scope !== undefined && layer.sections.size === 0 && layer.variables.size === 0) {
      if (this.scopedLayers.get(scope) === layer) this.scopedLayers.delete(scope)
    }
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

function createLayer(): PromptLayer {
  return { sections: new Map(), variables: new Map() }
}
