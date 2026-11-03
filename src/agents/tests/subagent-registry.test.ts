import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SubagentRuntime, subagentRunId, type SubagentProvider, type SubagentResult } from '@fly-novel/subagent'

test('Provider 按名称注册、查询与注销，旧注销函数不影响重新注册', () => {
  const service = new SubagentRuntime()
  const provider: SubagentProvider = { name: 'mock', async start() { throw new Error('未启动') } }
  assert.equal(service.getProvider('missing'), undefined)
  assert.throws(() => service.registerProvider({ ...provider, name: '  ' }), /名称不能为空/)
  const unregister = service.registerProvider(provider)
  assert.equal(service.getProvider('mock'), provider)
  assert.deepEqual(service.list(), ['mock'])
  assert.throws(() => service.registerProvider(provider), /已注册/)
  unregister()
  const unregisterAgain = service.registerProvider(provider)
  unregister()
  assert.equal(service.getProvider('mock'), provider)
  unregisterAgain()
  unregisterAgain()
  assert.deepEqual(service.list(), [])
})

test('注销与服务关闭不撤销调用方已持有的运行', async () => {
  let finish!: (value: SubagentResult) => void
  let disposed = false
  const result = new Promise<SubagentResult>(resolve => { finish = resolve })
  const provider: SubagentProvider = {
    name: 'mock',
    async start() {
      return { id: subagentRunId('run-1'), result, async dispose() { disposed = true } }
    },
  }
  const service = new SubagentRuntime()
  const unregister = service.registerProvider(provider)
  const registered = service.getProvider('mock')
  assert.ok(registered)
  const run = await registered.start({ parent: { info: { identity: { id: 'parent' } } }, prompt: '任务', signal: new AbortController().signal })
  unregister()
  assert.equal(service.getProvider('mock'), undefined)
  service.dispose()
  service.dispose()
  unregister()
  assert.equal(disposed, false)
  assert.throws(() => service.getProvider('mock'), /已关闭/)
  assert.throws(() => service.list(), /已关闭/)
  assert.throws(() => service.registerProvider(provider), /已关闭/)
  finish({ output: '完成', stopReason: 'completed' })
  assert.deepEqual(await run.result, { output: '完成', stopReason: 'completed' })
  await run.dispose()
  assert.equal(disposed, true)
})
