import type { ToolSchema } from '@fly-novel/llm'
import type { ToolDefinition } from './contracts.js'

/** 当前 Agent 的工具注册表；服务销毁后不可再使用。 */
export class ToolsService {
  private readonly tools = new Map<string, ToolDefinition>()
  private closed = false

  /** 注册工具并返回仅注销本次注册的函数；同名工具不能重复注册。 */
  register(definition: ToolDefinition): () => void {
    this.assertOpen()
    if (definition.name === 'run_code') throw new Error('工具名称 run_code 为官方保留名称')
    if (this.tools.has(definition.name)) throw new Error(`工具 "${definition.name}" 已注册`)
    if (!definition.output || typeof definition.output.render !== 'function' || !definition.output.schema) {
      throw new TypeError(`工具 "${definition.name}" 必须声明 output.schema 和 output.render`)
    }
    this.tools.set(definition.name, definition)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.tools.get(definition.name) === definition) this.tools.delete(definition.name)
    }
  }

  /** 按名称获取当前 Agent 可见的工具，未注册时返回 undefined。 */
  get(name: string): ToolDefinition | undefined {
    this.assertOpen()
    return this.tools.get(name)
  }

  /** 返回当前 Agent 的工具定义列表。 */
  definitions(): readonly ToolDefinition[] {
    this.assertOpen()
    return [...this.tools.values()]
  }

  /** 投影并复制模型可见字段，不包含执行及输出函数。 */
  schemas(): ToolSchema[] {
    return this.definitions().map(({ name, description, parameters }) => ({
      name, description, parameters: structuredClone(parameters),
    }))
  }

  /** 清空注册并关闭服务，可重复调用。 */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.tools.clear()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('ToolsService 已销毁')
  }
}
