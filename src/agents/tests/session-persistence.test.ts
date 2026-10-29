import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { Session } from '@fly-novel/session'
import type { SessionEvent } from '@fly-novel/session'
import { SessionPersistence, type SessionAccess, type SessionHandle, type SessionHeader } from '@fly-novel/session-persistence'

interface RecordEntry { header: SessionHeader; events: SessionEvent[] }

/** 仅用于验证服务契约；所有数据随测试进程结束消失。 */
class MemoryPersistence extends SessionPersistence {
  private readonly records = new Map<string, RecordEntry>()
  private readonly handles = new Set<SessionHandle>()

  async create(header: SessionHeader): Promise<SessionHandle> {
    if (this.records.has(header.id)) throw new Error('Session 已存在')
    const record = { header: structuredClone(header), events: [] }
    this.records.set(header.id, record)
    return this.makeHandle(record, 'write')
  }
  async open(id: string, access: SessionAccess): Promise<SessionHandle> {
    const record = this.records.get(id)
    if (!record) throw new Error('Session 不存在')
    return this.makeHandle(record, access)
  }
  async flush(): Promise<void> {
    for (const handle of this.handles) if (handle.access === 'write') await handle.flush()
  }
  async stat(id: string) {
    const record = this.records.get(id)
    return record ? { header: structuredClone(record.header) } : undefined
  }
  async list() { return [...this.records.values()].map(({ header }) => ({ header: structuredClone(header) })) }

  private makeHandle(record: RecordEntry, access: SessionAccess): SessionHandle {
    let closed = false
    const assertOpen = () => { if (closed) throw new Error('句柄已关闭') }
    const handle: SessionHandle = {
      id: record.header.id,
      header: Object.freeze({ ...record.header }),
      access,
      async read(offset = 0, length = Number.POSITIVE_INFINITY) {
        assertOpen()
        if (!Number.isSafeInteger(offset) || offset < 0 || !(length === Infinity || Number.isSafeInteger(length) && length >= 0)) throw new Error('读取范围无效')
        return { events: structuredClone(record.events.slice(offset, offset + length)) }
      },
      async append(events) {
        assertOpen()
        if (access !== 'write') throw new Error('只读句柄')
        if (events.some((event, index) => event.seq !== record.events.length + index)) throw new Error('事件序号不连续')
        record.events.push(...structuredClone(events))
      },
      async flush() { assertOpen(); if (access !== 'write') throw new Error('只读句柄') },
      close: async () => { if (!closed) { closed = true; this.handles.delete(handle) } },
    }
    this.handles.add(handle)
    return handle
  }
}

test('Session 持久化服务创建、打开、读取、追加和关闭', async (t) => {
  const { Context } = await import('@deepseek-ai/cordis')
  const root = new Context()
  const scope = root.plugin((ctx: Context) => { new MemoryPersistence(ctx) })
  await scope
  t.after(() => scope.dispose())
  const persistence = scope.ctx.get('sessionPersistence')
  assert.ok(persistence)
  const header = { id: 'session-1', createdAt: '2026-01-01T00:00:00.000Z' }
  const writer = await persistence.create(header)
  await assert.rejects(persistence.create(header), /已存在/)
  await assert.rejects(persistence.open('missing', 'read'), /不存在/)
  const session = new Session({ id: header.id, createdAt: new Date(header.createdAt) })
  const first = session.append('turn/start', { turn: 1 })
  const second = session.append('step/start', { turn: 1, step: 1 })
  await writer.append([first, second])
  await assert.rejects(writer.append([first]), /不连续/)
  await persistence.flush()
  assert.deepEqual(await persistence.stat(header.id), { header })
  assert.deepEqual(await persistence.list(), [{ header }])
  const reader = await persistence.open(header.id, 'read')
  assert.deepEqual((await reader.read(1, 1)).events, [second])
  await assert.rejects(reader.append([]), /只读/)
  await assert.rejects(reader.flush(), /只读/)
  await writer.close()
  await writer.close()
  await assert.rejects(writer.read(), /已关闭/)
  await reader.close()
  const reopened = await persistence.open(header.id, 'write')
  assert.deepEqual((await reopened.read()).events, [first, second])
  await reopened.close()
  session.close()
  await scope.dispose()
  assert.equal(root.get('sessionPersistence'), undefined)
})
