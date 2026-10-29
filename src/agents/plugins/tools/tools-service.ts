import type { ToolSchema } from '@fly-novel/llm'
import { snapshotJsonValue } from '@fly-novel/util'
import { validateJsonSchemaValue, assertSupportedJsonSchema, isJsonValue } from './json-schema.js'
import type { ToolAgentIdentity, ToolDefinition, ToolBatchInput, ToolBatchResult, ToolExecutionResult } from './contracts.js'

/** 当前 Agent 的工具注册表；服务销毁后不可再使用。 */
export class ToolsService {
  private readonly tools = new Map<string, ToolDefinition>()
  private closed = false

  private readonly agent: ToolAgentIdentity | undefined

  constructor(agent?: ToolAgentIdentity) {
    this.agent = agent === undefined ? undefined : Object.freeze({ ...agent })
  }

  /** 注册工具并返回仅注销本次注册的函数；同名工具不能重复注册。 */
  register(definition: ToolDefinition): () => void {
    this.assertOpen()
    if (definition.name === 'run_code') throw new Error('工具名称 run_code 为官方保留名称')
    if (this.tools.has(definition.name)) throw new Error(`工具 "${definition.name}" 已注册`)
    if (!definition.output || typeof definition.output.render !== 'function' || !definition.output.schema) {
      throw new TypeError(`工具 "${definition.name}" 必须声明 output.schema 和 output.render`)
    }
    assertSupportedJsonSchema(definition.output.schema)
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

  /** 执行一项模型调用；错误返回结构化结果。 */
  async execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    this.assertOpen()
    if (input.calls.length !== 1) throw new Error('当前只支持一项工具调用')
    const call = input.calls[0]!
    const failure = (code: string, message: string): ToolExecutionResult => ({
      isError: true, error: { message, info: { name: 'ToolError', code } },
      content: [{ type: 'text', text: `Error: ${message}` }],
    })
    let result: ToolExecutionResult
    const tool = this.tools.get(call.name)
    if (input.signal.aborted) {
      result = failure('ABORTED_BEFORE_DISPATCH', 'tool call aborted before dispatch')
    } else if (!tool) {
      result = failure('UNKNOWN_TOOL', `未知工具：${call.name}`)
    } else {
      try {
        let args: unknown
        try { args = JSON.parse(call.arguments) } catch { throw new ToolCallError('INVALID_ARGS', '工具参数不是有效 JSON') }
        const snapshot = snapshotJsonValue(args)
        if (snapshot === undefined) throw new ToolCallError('INVALID_ARGS', '工具参数必须是无损 JSON')
        const value = await tool.execute(snapshot, {
          callId: call.id, name: call.name, ...(this.agent === undefined ? {} : { agent: this.agent }),
          workingDirectory: input.workingDirectory, signal: input.signal,
        })
        if (input.signal.aborted) throw new ToolCallError('ABORTED', 'tool call aborted')
        const canonical = snapshotJsonValue(value)
        if (!isJsonValue(canonical) || validateJsonSchemaValue(tool.output.schema, canonical, '').length > 0) {
          throw new ToolCallError('INVALID_TOOL_OUTPUT', '工具输出不符合声明的 schema')
        }
        result = { isError: false, value: canonical, content: tool.output.render(snapshot, canonical) }
      } catch (error) {
        const code = input.signal.aborted ? 'ABORTED' : error instanceof ToolCallError ? error.code :
          error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'TOOL_ERROR'
        result = failure(code, error instanceof Error ? error.message : '工具执行失败')
      }
    }
    return { results: [{ callId: call.id, result }] }
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

class ToolCallError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
