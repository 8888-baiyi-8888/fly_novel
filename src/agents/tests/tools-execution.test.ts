import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ToolCallId } from '@fly-novel/llm'
import { defineTool, ToolsService } from '../plugins/tools/index.js'
import { readFileTool } from '../../tools/filesystem/read-file.js'

const id = 'call-1' as ToolCallId
const signal = new AbortController().signal
const call = (name: string, args: string) => ({ type: 'tool-call' as const, id, name, arguments: args })

test('工具服务执行真实 read_file 并返回与调用 ID 关联的文件内容', async (t) => {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'fly-novel-tool-execution-'))
  t.after(() => rm(workingDirectory, { recursive: true, force: true }))
  await writeFile(join(workingDirectory, 'outline.txt'), '第一章：启程', 'utf8')
  const tools = new ToolsService()
  tools.register(readFileTool)
  const result = await tools.execute({
    calls: [call('read_file', '{"path":"outline.txt"}')], signal, workingDirectory,
  })
  assert.deepEqual(result.results[0], {
    callId: id,
    result: { isError: false, value: '第一章：启程', content: [{ type: 'text', text: '第一章：启程' }] },
  })
})

test('工具服务解析参数、执行工具并返回关联的规范值和模型内容', async () => {
  const tools = new ToolsService()
  tools.register(defineTool({
    name: 'sample', description: '测试类型',
    parameters: {
      number: { type: 'integer', required: true },
      flags: { type: 'array', items: { type: 'boolean' }, required: true },
      data: { type: 'object', properties: { name: { type: 'string', required: true } }, additionalProperties: false, required: true },
      choice: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    },
    output: { schema: { type: 'object', properties: { answer: { type: 'integer', required: true } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: String(value.answer) }] },
    async execute(args) { return { answer: args.number } },
  }))
  const run = (name: string, args: string) => tools.execute({ calls: [call(name, args)], signal, workingDirectory: '.' })
  const ok = await run('sample', '{"number":3,"flags":[true],"data":{"name":"x"},"choice":null}')
  assert.deepEqual(ok.results[0], { callId: id, result: { isError: false, value: { answer: 3 }, content: [{ type: 'text', text: '3' }] } })
  for (const [name, args, code] of [
    ['missing', '{}', 'UNKNOWN_TOOL'], ['sample', '{', 'INVALID_ARGS'],
    ['sample', '{"number":3.5,"flags":[true],"data":{"name":"x"},"choice":null}', 'INVALID_ARGS'],
    ['sample', '{"number":3,"flags":[true],"data":{"name":"x","extra":1},"choice":null}', 'INVALID_ARGS'],
  ]) {
    const outcome = (await run(name!, args!)).results[0]?.result
    assert.ok(outcome?.isError)
    assert.equal(outcome.error.info.code, code)
  }
})

test('工具服务拒绝无效输出并传递取消信号', async () => {
  const tools = new ToolsService()
  tools.register({ name: 'invalid', description: '无效输出', parameters: { type: 'object' },
    output: { schema: { type: 'integer' }, render: () => [] }, async execute() { return 'wrong' } })
  const input = { calls: [call('invalid', '{}')], signal, workingDirectory: '.' }
  const invalid = (await tools.execute(input)).results[0]?.result
  assert.ok(invalid?.isError)
  assert.equal(invalid.error.info.code, 'INVALID_TOOL_OUTPUT')
  const canceled = (await tools.execute({ ...input, signal: AbortSignal.abort() })).results[0]?.result
  assert.ok(canceled?.isError)
  assert.equal(canceled.error.info.code, 'ABORTED_BEFORE_DISPATCH')
  await assert.rejects(tools.execute({ ...input, calls: [] }), /只支持一项/)
})

test('工具执行中的取消信号传给工具并等待其结束', async () => {
  const tools = new ToolsService()
  const controller = new AbortController()
  let observed = false
  tools.register({ name: 'wait', description: '等待取消', parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      assert.equal(exec.signal, controller.signal)
      await new Promise<void>((resolve) => exec.signal.addEventListener('abort', () => { observed = true; resolve() }, { once: true }))
      return 'finished'
    },
  })
  const pending = tools.execute({ calls: [call('wait', '{}')], signal: controller.signal, workingDirectory: '.' })
  controller.abort()
  const result = (await pending).results[0]?.result
  assert.equal(observed, true)
  assert.ok(result?.isError)
  assert.equal(result.error.info.code, 'ABORTED')
})
