import type { SubagentProvider } from './types.js'

/** 管理当前服务作用域内的具名 Subagent Provider。 */
export class SubagentRuntime {
  private readonly providers = new Map<string, { readonly provider: SubagentProvider }>()
  private disposed = false

  /**
   * 注册一个名称唯一的 Provider。
   * @param provider 要注册的 Provider；名称在注册期间不得改变。
   * @returns 可重复调用的注销函数，仅移除本次注册。
   * @throws 服务已关闭、名称为空或名称已注册时抛错。
   */
  registerProvider(provider: SubagentProvider): () => void {
    this.assertOpen()
    const name = provider.name
    if (!name.trim()) throw new Error('Subagent Provider 名称不能为空')
    if (this.providers.has(name)) throw new Error(`Subagent Provider "${name}" 已注册`)
    const registration = { provider }
    this.providers.set(name, registration)
    return () => {
      if (this.providers.get(name) === registration) this.providers.delete(name)
    }
  }

  /** 按名称查找 Provider；未注册时返回 undefined，服务关闭后拒绝查询。 */
  getProvider(name: string): SubagentProvider | undefined {
    this.assertOpen()
    return this.providers.get(name)?.provider
  }

  /** 按注册顺序返回 Provider 名称；服务关闭后拒绝查询。 */
  list(): string[] {
    this.assertOpen()
    return [...this.providers.keys()]
  }

  /** 关闭服务并移除注册；已交付的运行仍由持有方负责释放。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.providers.clear()
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Subagent 服务已关闭')
  }
}
