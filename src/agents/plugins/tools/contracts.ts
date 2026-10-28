import type { ContentBlock, ToolCallBlock, ToolCallId, ToolSchema } from '@fly-novel/llm'
import type { JsonValue } from '@fly-novel/util'
import type { JsonSchemaNode } from './json-schema.js'

/** 调用方提供的授权目录和取消信号。 */
export interface ToolRunContext { readonly workingDirectory: string; readonly signal: AbortSignal }

/** 规范输出 schema 及模型内容投影；调用方传入已校验的参数和输出。 */
export interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode
  render(args: unknown, value: JsonValue): ContentBlock[]
}

/** 工具的模型 schema、规范输出声明和执行函数。 */
export interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}

/** 一次工具执行的规范值、模型可见内容或错误。 */
export type ToolExecutionResult =
  | { readonly isError: false; readonly value: JsonValue; readonly content: ContentBlock[] }
  | { readonly isError: true; readonly error: { readonly message: string; readonly info: { readonly name: string; readonly code: string } }; readonly content: ContentBlock[] }

/** 本阶段只接受一项调用；授权目录由调用方提供。 */
export interface ToolBatchInput {
  readonly calls: readonly ToolCallBlock[]
  readonly signal: AbortSignal
  readonly workingDirectory: string
}

/** 按调用 ID 关联执行结果。 */
export interface ToolBatchResult {
  readonly results: readonly { readonly callId: ToolCallId; readonly result: ToolExecutionResult }[]
}

