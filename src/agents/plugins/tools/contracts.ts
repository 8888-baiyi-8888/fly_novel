import type { ContentBlock, ToolSchema } from '@fly-novel/llm'

/** 调用方提供的授权目录和取消信号。 */
export interface ToolRunContext { readonly workingDirectory: string; readonly signal: AbortSignal }

/** 规范输出 schema 及模型内容投影；调用方传入已校验的参数和输出。 */
export interface ToolOutputDefinition {
  readonly schema: Record<string, unknown>
  render(args: unknown, value: unknown): ContentBlock[]
}

/** 工具的模型 schema、规范输出声明和执行函数。 */
export interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}

