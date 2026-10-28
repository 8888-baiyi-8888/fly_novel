import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootstrapAgents } from '../core/bootstrap.js'
import { defineTool } from '../plugins/tools/index.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

test('Tools 服务注册、投影和注销在 Agent 之间隔离，随 Agent 清理', async () => {
  const framework = await bootstrapAgents()
  try {
    framework.presets.register({ id: 'tools-test', version: '1', role: 'character',
      plugins: withAgentLoop([{ pluginId: 'tools' }]) })
    const first = await createTestAgent(framework, { id: 'tools-a', presetId: 'tools-test' })
    const second = await createTestAgent(framework, { id: 'tools-b', presetId: 'tools-test' })
    const toolsA = first.context.get('tools')
    const toolsB = second.context.get('tools')
    assert.ok(toolsA && toolsB)
    const tool = defineTool({ name: 'lookup', description: '查询',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) { return args.path },
    })
    const unregister = toolsA.register(tool)
    assert.equal(toolsA.get('lookup'), tool)
    assert.equal(toolsB.get('lookup'), undefined)
    assert.deepEqual(toolsA.definitions(), [tool])
    assert.throws(() => toolsA.register(tool), /已注册/)
    const schema = toolsA.schemas()
    assert.deepEqual(schema, [{ name: 'lookup', description: '查询', parameters: tool.parameters }])
    schema[0]!.parameters.type = 'changed'
    assert.equal(toolsA.schemas()[0]?.parameters.type, 'object')
    unregister()
    const unregisterNew = toolsA.register(tool)
    unregister()
    assert.equal(toolsA.get('lookup'), tool)
    toolsB.register(tool)
    await framework.manager.dispose('tools-a')
    assert.equal(first.context.get('tools'), undefined)
    assert.throws(() => toolsA.schemas(), /已销毁/)
    unregisterNew()
    assert.equal(toolsB.get('lookup'), tool)
  } finally {
    await framework.manager.disposeAll()
  }
})
