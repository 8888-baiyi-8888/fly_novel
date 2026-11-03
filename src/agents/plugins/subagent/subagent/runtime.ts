import type { SubagentProvider, SubagentRun, SubagentStartRequest } from './types.js'

interface PendingStart {
  readonly controller: AbortController
  readonly done: Promise<void>
  readonly cleanupErrors: unknown[]
}

/** 管理当前服务作用域内的具名 Subagent Provider。 */
export class SubagentRuntime {
  private readonly providers = new Map<string, { readonly provider: SubagentProvider }>()
  private disposed = false
  private readonly pending = new Set<PendingStart>()
  private disposePromise?: Promise<void>

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

  /**
   * 通过具名 Provider 启动任务；返回时运行已经发布，结果可能仍在执行。
   * @param name 已注册的 Provider 名称。
   * @param request 任务、父 Agent 和取消信号。
   * @returns 调用方持有的运行句柄。
   * @throws 服务关闭、Provider 未注册、启动取消或 Provider 启动失败时拒绝。
   */
  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    this.assertOpen()
    const provider = this.providers.get(name)?.provider
    if (!provider) throw new Error(`Subagent Provider "${name}" 未注册`)
    request.signal.throwIfAborted()

    const controller = new AbortController()
    const signal = AbortSignal.any([request.signal, controller.signal])
    let finish!: () => void
    const pending: PendingStart = { controller, done: new Promise<void>(resolve => { finish = resolve }), cleanupErrors: [] }
    this.pending.add(pending)
    try {
      const run = await provider.start({ ...request, signal })
      if (signal.aborted) {
        // 无调用方接收句柄，服务必须处理结果拒绝并释放运行。
        void run.result.catch(() => undefined)
        try {
          await run.dispose()
        } catch (error) {
          pending.cleanupErrors.push(error)
          throw new AggregateError([signal.reason, error], 'Subagent 启动取消且清理失败')
        }
        signal.throwIfAborted()
      }
      return run
    } finally {
      this.pending.delete(pending)
      finish()
    }
  }

  /** 关闭注册并取消、等待未交付的启动；已交付的运行仍由持有方释放。 */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    this.providers.clear()
    const pending = [...this.pending]
    let resolveDispose!: () => void
    let rejectDispose!: (reason: unknown) => void
    this.disposePromise = new Promise<void>((resolve, reject) => { resolveDispose = resolve; rejectDispose = reject })
    for (const item of pending) item.controller.abort(new Error('Subagent 服务已关闭'))
    void Promise.all(pending.map(item => item.done)).then(() => {
      const errors = pending.flatMap(item => item.cleanupErrors)
      if (errors.length) rejectDispose(new AggregateError(errors, 'Subagent 启动清理失败'))
      else resolveDispose()
    })
    return this.disposePromise
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('Subagent 服务已关闭')
  }
}
