import type { Agent } from '../core/contracts/agent.js'
import type { CreateAgentOptions } from '../core/contracts/preset.js'
import { AgentFactory } from './agent-factory.js'

/** 管理已创建的 Agent 与正在初始化的同名 Agent。 */
export class AgentManager {
  private readonly items = new Map<string, Agent>()
  private readonly pending = new Map<string, Promise<Agent>>()
  private disposeAllPromise?: Promise<void>

  constructor(private readonly factory: AgentFactory) {}

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

  get(id: string): Agent {
    const agent = this.items.get(id)
    if (!agent) throw new Error(`Agent "${id}" 不存在`)
    return agent
  }

  list(): Agent[] {
    return [...this.items.values()]
  }

  async dispose(id: string): Promise<void> {
    if (this.disposeAllPromise) return this.disposeAllPromise
    const pending = this.pending.get(id)
    if (pending) await pending.catch(() => undefined)
    const agent = this.items.get(id)
    if (!agent) return
    this.items.delete(id)
    await agent.dispose()
  }

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
