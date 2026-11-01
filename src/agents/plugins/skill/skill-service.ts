/** Skill 摘要不包含完整指导。 */
export interface SkillSummary {
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
}

export interface SkillDefinition extends SkillSummary {
  readonly resourceBase: { readonly kind: 'directory'; readonly path: string }
  readonly content: string
}

/** 提供方自行检查其来源和授权范围。 */
export interface SkillProvider {
  readonly name: string
  list(workingDirectory: string, signal: AbortSignal): Promise<readonly SkillSummary[]>
  get(name: string, workingDirectory: string, signal: AbortSignal): Promise<SkillDefinition>
}

/** 注册 Skill 来源，查询摘要并按名称加载。 */
export class SkillService {
  private readonly providers = new Map<string, SkillProvider>()
  private readonly controller = new AbortController()
  private revision = 0
  private disposed = false

  /** 注册名称唯一的来源；返回可重复调用的注销函数。 */
  registerProvider(provider: SkillProvider): () => void {
    this.assertOpen()
    if (!provider.name.trim()) throw new Error('Skill 提供方名称不能为空')
    if (this.providers.has(provider.name)) throw new Error(`Skill 提供方 "${provider.name}" 已注册`)
    this.providers.set(provider.name, provider)
    this.revision++
    return () => {
      if (this.providers.get(provider.name) !== provider) return
      this.providers.delete(provider.name)
      this.revision++
    }
  }

  /** 来源出错、同名或查询中注册变化时抛错，不返回不完整结果。 */
  async list(workingDirectory: string, signal: AbortSignal): Promise<readonly SkillSummary[]> {
    this.assertOpen()
    const revision = this.revision
    const combined = AbortSignal.any([signal, this.controller.signal])
    const found = new Map<string, SkillSummary>()
    for (const provider of this.providers.values()) {
      combined.throwIfAborted()
      const entries = await provider.list(workingDirectory, combined)
      combined.throwIfAborted()
      this.assertRevision(revision)
      for (const entry of entries) {
        if (entry.provider !== provider.name) throw new Error('Skill 摘要的提供方与注册来源不一致')
        if (found.has(entry.name)) throw new Error(`Skill "${entry.name}" 存在同名冲突`)
        found.set(entry.name, entry)
      }
    }
    combined.throwIfAborted()
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 未找到返回 undefined；内容与摘要不一致或来源变化时抛错。 */
  async get(name: string, workingDirectory: string, signal: AbortSignal): Promise<SkillDefinition | undefined> {
    const revision = this.revision
    const summary = (await this.list(workingDirectory, signal)).find(item => item.name === name)
    if (!summary) return undefined
    const provider = this.providers.get(summary.provider)
    if (!provider) throw new Error('Skill 提供方在查询期间发生变化')
    const combined = AbortSignal.any([signal, this.controller.signal])
    const result = await provider.get(name, workingDirectory, combined)
    combined.throwIfAborted()
    this.assertRevision(revision)
    if (result.name !== name || result.provider !== provider.name) throw new Error('Skill 内容与查询结果不一致')
    return result
  }

  /** 取消查询并注销来源；来源自行管理其其他资源。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort()
    this.providers.clear()
    this.revision++
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Skill 服务已关闭')
  }

  private assertRevision(revision: number): void {
    this.assertOpen()
    if (this.revision !== revision) throw new Error('Skill 提供方在查询期间发生变化')
  }
}
