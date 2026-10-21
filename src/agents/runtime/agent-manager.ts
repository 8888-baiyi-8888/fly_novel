import type { Agent } from '../core/contracts/agent.js'
import type { CreateAgentOptions } from '../core/contracts/preset.js'
import { AgentFactory } from './agent-factory.js'

/** 按 ID 持有 Agent 实例，并统一管理创建冲突与实例清理。 */
export class AgentManager {
  private readonly items = new Map<string, Agent>()
  private readonly pending = new Map<string, Promise<Agent>>()
  private disposeAllPromise?: Promise<void>

  constructor(private readonly factory: AgentFactory) {}

  /**
   * 通过工厂创建 Agent；初始化期间也占用其 ID，失败后释放该 ID。
   * @param options 传给工厂的 Agent 创建选项。
   * @returns 已初始化且纳入管理的 Agent。
   * @throws ID 已占用、Manager 正在清理，或工厂创建失败时抛错。
   */
  async create(options: CreateAgentOptions): Promise<Agent> {
    if (this.disposeAllPromise) throw new Error('Agent Manager 正在清理')
    if (this.items.has(options.id) || this.pending.has(options.id)) {
      throw new Error(`Agent "${options.id}" 已存在`)
    }

    const creation = this.factory.create(options)
    this.pending.set(options.id, creation)
    try {
      const agent = await creation
      this.items.set(options.id, agent)
      return agent
    } finally {
      this.pending.delete(options.id)
    }
  }

  /** 按 ID 取得已创建的 Agent；不存在时抛错。 */
  get(id: string): Agent {
    const agent = this.items.get(id)
    if (!agent) throw new Error(`Agent "${id}" 不存在`)
    return agent
  }

  /** 返回当前已创建 Agent 的列表，不包含仍在初始化的实例。 */
  list(): Agent[] {
    return [...this.items.values()]
  }

  /** 等待指定 ID 的初始化结束，再销毁并移除实例；不存在时直接返回。 */
  async dispose(id: string): Promise<void> {
    if (this.disposeAllPromise) return this.disposeAllPromise
    const pending = this.pending.get(id)
    if (pending) await pending.catch(() => undefined)
    const agent = this.items.get(id)
    if (!agent) return
    this.items.delete(id)
    await agent.dispose()
  }

  /** 等待所有初始化结束，逆登记顺序销毁实例；汇总清理错误。 */
  disposeAll(): Promise<void> {
    if (this.disposeAllPromise) return this.disposeAllPromise
    this.disposeAllPromise = this.disposeAllItems()
    return this.disposeAllPromise
  }

  private async disposeAllItems(): Promise<void> {
    try {
      await Promise.allSettled(this.pending.values())
      const agents = [...this.items.values()].reverse()
      this.items.clear()
      const errors: unknown[] = []
      for (const agent of agents) {
        try {
          await agent.dispose()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) throw new AggregateError(errors, '清理 Agent 实例失败')
    } finally {
      this.disposeAllPromise = undefined
    }
  }
}
