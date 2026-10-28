import type { ToolSchema } from '@fly-novel/llm'

/** 调用方提供的授权工作目录。 */
export interface ToolRunContext { readonly workingDirectory: string }

/** 工具的模型描述和直接执行入口。 */
export interface ToolDefinition<Args, Result> extends ToolSchema {
  execute(args: Args, exec: ToolRunContext): Promise<Result>
}

/** 保留工具定义的参数与返回类型。 */
export function defineTool<Args, Result>(definition: ToolDefinition<Args, Result>): ToolDefinition<Args, Result> {
  return definition
}
