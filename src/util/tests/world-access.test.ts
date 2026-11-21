import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { WorldAccess, withWorldAccess } from '../world-access'

test('世界访问在模块队列之前串行化，嵌套访问不死锁', async () => {
  const root = resolve('tmp/world-access-a'); const gate = WorldAccess.register([root, resolve('tmp/world-access-pending')])
  let enter!: () => void; let release!: () => void
  const entered = new Promise<void>(done => { enter = done }); const wait = new Promise<void>(done => { release = done })
  const order: string[] = []
  const first = gate.run(async () => {
    order.push('开始'); enter(); await wait
    await withWorldAccess([resolve(root, 'map/place.json')], async () => { order.push('嵌套') })
    order.push('完成')
  })
  await entered
  const second = withWorldAccess([resolve(root, 'character/profile.md')], async () => { order.push('后续') })
  await Promise.resolve(); assert.deepEqual(order, ['开始'])
  release(); await Promise.all([first, second]); assert.deepEqual(order, ['开始', '嵌套', '完成', '后续'])
  await gate.close()
})

test('活动的未绑定操作阻止注册，关闭等待操作并拒绝新任务', async () => {
  const root = resolve('tmp/world-access-b'); let release!: () => void
  const wait = new Promise<void>(done => { release = done })
  const active = withWorldAccess([resolve(root, 'place')], async () => wait)
  assert.throws(() => WorldAccess.register([root]), /未完成/)
  release(); await active
  const gate = WorldAccess.register([root]); assert.throws(() => WorldAccess.register([resolve(root, 'child')]), /重叠/)
  let finish!: () => void; const pending = new Promise<void>(done => { finish = done })
  const operation = gate.run(async () => pending); const closing = gate.close()
  await assert.rejects(gate.run(async () => undefined), /关闭/)
  finish(); await Promise.all([operation, closing])
  const reopened = WorldAccess.register([root]); await reopened.close()
})

test('跨世界嵌套或跨世界文件操作被拒绝', async () => {
  const a = resolve('tmp/world-access-c'); const b = resolve('tmp/world-access-d')
  const first = WorldAccess.register([a]); const second = WorldAccess.register([b])
  try {
    await assert.rejects(first.run(() => second.run(async () => undefined)), /不同世界/)
    await assert.rejects(withWorldAccess([resolve(a, 'one'), resolve(b, 'two')], async () => undefined), /多个世界/)
    await assert.rejects(first.run(() => first.close()), /操作中关闭/)
  } finally { await first.close(); await second.close() }
})

test('未等待的嵌套协调操作完成之前不释放世界占用', async () => {
  const root = resolve('tmp/world-access-children'); const gate = WorldAccess.register([root])
  let release!: () => void; let entered!: () => void
  const wait = new Promise<void>(done => { release = done }); const started = new Promise<void>(done => { entered = done })
  const first = gate.run(async () => { void withWorldAccess([root], async () => { entered(); await wait }) })
  await started
  let secondDone = false
  const second = gate.run(async () => { secondDone = true })
  await Promise.resolve(); assert.equal(secondDone, false)
  release(); await Promise.all([first, second]); assert.equal(secondDone, true)
  await gate.close()
})
