import type { ContentBlock, ToolCallBlock, ToolCallId, ToolSchema } from '@fly-novel/llm'
import type { JsonValue } from '@fly-novel/util'
import type { JsonSchemaNode } from './json-schema.js'
import type { Session } from '@fly-novel/session'

/** 由 Harness 提供的 Agent 身份；独立服务调用时不存在。 */
export interface ToolAgentIdentity {
  readonly id: string
  readonly name: string
  readonly role: string
}

/** 工具实际调用的身份、授权目录和取消信号。 */
export interface ToolRunContext {
  readonly callId: ToolCallId
  readonly name: string
  readonly agent?: ToolAgentIdentity
  readonly workingDirectory: string
  readonly signal: AbortSignal
}

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

/** 工具调用批次；授权目录由调用方提供。 */
export interface ToolBatchInput {
  readonly calls: readonly ToolCallBlock[]
  readonly signal: AbortSignal
  readonly workingDirectory: string
  /** 写入当前 Step 的调用和结果；独立调用时可省略。 */
  readonly log?: { readonly session: Session; readonly turn: number; readonly step: number; readonly checkpoint?: () => Promise<void> }
}

/** 按调用 ID 关联执行结果。 */
export interface ToolBatchResult {
  readonly results: readonly { readonly callId: ToolCallId; readonly result: ToolExecutionResult }[]
}

