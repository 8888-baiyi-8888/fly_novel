import { LlmBaseError } from '@fly-novel/llm'
import type { ContentBlock } from '@fly-novel/llm'
import type { ToolDefinition, ToolRunContext } from './contracts.js'

/** 当前支持的工具参数声明。 */
export interface StringValueSchemaSpec { readonly type: 'string'; readonly description?: string; readonly required?: true }
export type ParameterSchemaSpec = Record<string, StringValueSchemaSpec>
type InferArgs<S extends ParameterSchemaSpec> = {
  [K in keyof S as S[K] extends { required: true } ? K : never]: string
} & { [K in keyof S as S[K] extends { required: true } ? never : K]?: string }

/** 参数不符合工具声明时的错误。 */
export class ToolArgsError extends LlmBaseError {
  constructor(readonly violations: string[]) {
    super(`invalid arguments: ${violations.join('; ')}`, 'INVALID_ARGS')
    this.name = 'ToolArgsError'
  }
}

/** 将工具参数声明编译为对象 JSON Schema。 */
export function parameterSchemaSpecToJsonSchema(specifications: ParameterSchemaSpec): {
  type: 'object'
  properties: Record<string, { type: 'string'; description?: string }>
  required?: string[]
} {
  const properties: Record<string, { type: 'string'; description?: string }> = {}
  const required: string[] = []
  for (const [name, spec] of Object.entries(specifications)) {
    if (!spec || spec.type !== 'string' || Object.keys(spec).some(key => !['type', 'description', 'required'].includes(key)) ||
        (spec.required !== undefined && spec.required !== true) ||
        (spec.description !== undefined && typeof spec.description !== 'string')) {
      throw new Error(`不支持参数 schema：${name}`)
    }
    Object.defineProperty(properties, name, {
      value: { type: 'string', ...(spec.description === undefined ? {} : { description: spec.description }) },
      enumerable: true,
    })
    if (spec.required) required.push(name)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** 编译工具参数 schema，并在执行前校验参数。 */
export function defineTool<const S extends ParameterSchemaSpec>(options: {
  readonly name: string
  readonly description: string
  readonly parameters: S
  readonly output: { readonly schema: { readonly type: 'string' }; render(args: InferArgs<S>, value: string): ContentBlock[] }
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<string>
}): ToolDefinition {
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters)
  if (options.output.schema.type !== 'string' || Object.keys(options.output.schema).some(key => key !== 'type')) {
    throw new Error('不支持输出 schema')
  }
  const required = new Set(parameters.required)
  const userExecute = options.execute
  const userRender = options.output.render
  function validate(args: unknown): void {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new ToolArgsError(['arguments must be an object'])
    const violations: string[] = []
    for (const name of Object.keys(parameters.properties)) {
      const present = Object.hasOwn(args, name)
      if (!present && required.has(name)) violations.push(`${name} is required`)
      else if (present && typeof Reflect.get(args, name) !== 'string') violations.push(`${name} must be a string`)
    }
    if (violations.length > 0) throw new ToolArgsError(violations)
  }
  return {
    name: options.name, description: options.description, parameters,
    output: { schema: { type: 'string' }, render(args, value) {
      // 与官方契约一致：调用方负责传入已校验的参数和输出。
      return userRender(args as InferArgs<S>, value as string)
    } },
    async execute(args, exec) { validate(args); return userExecute(args as InferArgs<S>, exec) },
  }
}
