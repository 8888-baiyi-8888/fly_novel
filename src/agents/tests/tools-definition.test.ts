import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defineTool, ToolArgsError } from '../plugins/tools/index.js'

test('工具定义编译参数并在执行前校验，不受原始声明的后续修改影响', async () => {
  const parameters = { path: { type: 'string' as const, required: true as const } }
  let executions = 0
  const tool = defineTool({
    name: 'example', description: '示例', parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { executions++; return args.path },
  })
  const context = { workingDirectory: '.', signal: new AbortController().signal }
  Reflect.deleteProperty(parameters.path, 'required')
  await assert.rejects(tool.execute({}, context), ToolArgsError)
  await assert.rejects(tool.execute({ path: undefined }, context), ToolArgsError)
  assert.equal(executions, 0)
  assert.equal(await tool.execute({ path: 'ok', extra: true }, context), 'ok')
  assert.equal(executions, 1)
  assert.deepEqual(tool.output.render({ path: 'ok' }, 'ok'), [{ type: 'text', text: 'ok' }])
})
