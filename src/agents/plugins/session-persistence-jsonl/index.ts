import type { Context } from '@deepseek-ai/cordis'
import { mkdir, open, readFile, readdir, lstat, link, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { snapshotJsonValue } from '@fly-novel/util'
import type { SessionEvent } from '@fly-novel/session'
import { SessionPersistence, type SessionAccess, type SessionHandle, type SessionHeader } from '@fly-novel/session-persistence'

const VERSION = 2
const FILENAME = 'session.v2.jsonl'
const TYPES = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'system/message', 'user/message', 'assistant/message', 'tool/call', 'tool/result'])

/** JSONL 后端配置；root 是应用指定的绝对目录。 */
export interface JsonlSessionPersistenceConfig { readonly root: string }

/** 项目格式 v2：第一行是 session 头，其余每行是一个事件。 */
export class JsonlSessionPersistence extends SessionPersistence {
  private readonly root: string
  private readonly handles = new Set<SessionHandle>()
  private readonly writers = new Map<string, { handle: SessionHandle; pending: SessionEvent[]; active?: Promise<void>; failed: boolean }>()

  constructor(ctx: Context, config: JsonlSessionPersistenceConfig) {
    if (!config.root || !isAbsolute(config.root)) throw new Error('Session 存储 root 必须是绝对路径')
    super(ctx)
    this.root = resolve(config.root)
    ctx.on('session/event', (session, event) => {
      const writer = this.writers.get(session.id)
      if (!writer) return
      writer.pending.push(event)
      if (!writer.failed) void this.drain(writer).catch(() => undefined)
    })
    ctx.on('session/flush', async session => { await this.flushSession(session) })
    ctx.on('session/disposed', async session => {
      const writer = this.writers.get(session.id)
      if (!writer) return
      await this.flushSession(session)
      await writer.handle.close()
    })
    ctx.effect(() => async () => {
      const results = await Promise.allSettled([...this.handles].map(handle => handle.close()))
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, '关闭 Session 句柄失败')
    })
  }

  private directory(id: string): string {
    if (!id.trim() || Buffer.from(id, 'utf8').toString('utf8') !== id) throw new Error('Session ID 无效')
    return join(this.root, `s-${Buffer.from(id, 'utf8').toString('base64url')}`)
  }

  async create(header: SessionHeader): Promise<SessionHandle> {
    const dir = this.directory(header.id)
    if (!Number.isFinite(Date.parse(header.createdAt))) throw new Error('Session 创建时间无效')
    await mkdir(this.root, { recursive: true })
    try { await mkdir(dir) } catch (error) {
      if (isMissingCode(error, 'EEXIST')) throw new Error('Session 已存在')
      throw error
    }
    const file = await open(join(dir, FILENAME), 'wx')
    try {
      await file.writeFile(`${JSON.stringify({ type: 'session', version: VERSION, ...header })}\n`, 'utf8')
      await file.sync()
    } finally { await file.close() }
    return this.makeHandle(header, 'write')
  }

  async open(id: string, access: SessionAccess): Promise<SessionHandle> {
    if (access !== 'read' && access !== 'write') throw new Error('Session 访问模式无效')
    const loaded = await this.load(id)
    if (access === 'write') await this.prepareWrite(id, loaded)
    const { header } = loaded
    return this.makeHandle(header, access)
  }

  async stat(id: string) {
    try { return { header: (await this.load(id)).header } } catch (error) {
      if (isMissingCode(error, 'ENOENT')) return undefined
      throw error
    }
  }

  async list() {
    let entries
    try { entries = await readdir(this.root, { withFileTypes: true }) } catch (error) {
      if (isMissingCode(error, 'ENOENT')) return []
      throw error
    }
    const result = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('s-')) continue
      const encoded = entry.name.slice(2)
      const id = Buffer.from(encoded, 'base64url').toString('utf8')
      if (`s-${Buffer.from(id, 'utf8').toString('base64url')}` !== entry.name) throw new Error('Session 目录名称无效')
      result.push({ header: (await this.load(id)).header })
    }
    return result
  }

  async flush(): Promise<void> {
    const results = await Promise.allSettled([...this.writers.values()].map(async writer => {
      await this.drain(writer, true)
      await writer.handle.flush()
    }))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, '刷新 Session 失败')
  }

  private async load(id: string): Promise<{ header: SessionHeader; events: SessionEvent[]; version: number; validBytes: number; totalBytes: number }> {
    const dir = this.directory(id)
    if ((await lstat(dir)).isSymbolicLink()) throw new Error('Session 目录不能是符号链接')
    const entries = await readdir(dir)
    const versions = entries.flatMap(name => { const match = /^session\.v([1-9]\d*)\.jsonl$/.exec(name); return match ? [Number(match[1])] : [] })
    if (versions.length === 0) throw Object.assign(new Error('Session 文件不存在'), { code: 'ENOENT' })
    const version = Math.max(...versions)
    if (version > VERSION) throw new Error('Session 格式版本不支持')
    const filename = join(dir, `session.v${version}.jsonl`)
    if ((await lstat(filename)).isSymbolicLink()) throw new Error('Session 文件不能是符号链接')
    const bytes = await readFile(filename)
    const validBytes = bytes.lastIndexOf(10) + 1
    if (validBytes === 0) throw new Error('Session 日志头部不完整')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, validBytes))
    const rows = text.slice(0, -1).split('\n')
    let values: unknown[]
    try { values = rows.map(row => JSON.parse(row) as unknown) } catch { throw new Error('Session 日志不是有效 JSONL') }
    const head = values[0]
    if (!isRecord(head) || head.type !== 'session') throw new Error('Session 头部无效')
    if (head.version !== version) throw new Error('Session 格式版本不支持')
    if (head.id !== id || typeof head.createdAt !== 'string' || !Number.isFinite(Date.parse(head.createdAt))) throw new Error('Session 头部无效')
    const events: SessionEvent[] = []
    for (const value of values.slice(1)) {
      if (!isSessionEvent(value, events.length)) throw new Error('Session 事件无效或序号不连续')
      events.push(value)
    }
    if (head.toolCallCheckpoint !== undefined && typeof head.toolCallCheckpoint !== 'boolean') throw new Error('Session 头部无效')
    return { header: { id, createdAt: head.createdAt, ...(version === 1 || head.toolCallCheckpoint === undefined ? {} : { toolCallCheckpoint: head.toolCallCheckpoint }) }, events, version, validBytes, totalBytes: bytes.length }
  }

  private async prepareWrite(id: string, loaded: { header: SessionHeader; events: SessionEvent[]; version: number; validBytes: number; totalBytes: number }): Promise<void> {
    const dir = this.directory(id)
    if (loaded.version === VERSION) {
      if (loaded.validBytes !== loaded.totalBytes) {
        const file = await open(join(dir, FILENAME), 'r+')
        try { await file.truncate(loaded.validBytes); await file.sync() } finally { await file.close() }
      }
      return
    }
    const temp = join(dir, `.migration-${randomUUID()}`)
    const file = await open(temp, 'wx')
    try {
      try {
        const rows = [JSON.stringify({ type: 'session', version: VERSION, ...loaded.header }), ...loaded.events.map(event => JSON.stringify(event))]
        await file.writeFile(rows.join('\n') + '\n', 'utf8')
        await file.sync()
      } finally { await file.close() }
      await link(temp, join(dir, FILENAME))
    } finally { await unlink(temp) }
  }

  private makeHandle(header: SessionHeader, access: SessionAccess): SessionHandle {
    let closed = false
    const assertOpen = () => { if (closed) throw new Error('Session 句柄已关闭') }
    const handle: SessionHandle = {
      id: header.id, header: Object.freeze({ ...header }), access,
      read: async (offset = 0, length = Infinity) => {
        assertOpen()
        if (!Number.isSafeInteger(offset) || offset < 0 || !(length === Infinity || Number.isSafeInteger(length) && length >= 0)) throw new Error('读取范围无效')
        return { events: (await this.load(header.id)).events.slice(offset, offset + length) }
      },
      append: async events => {
        assertOpen()
        if (access !== 'write') throw new Error('Session 句柄只读')
        const current = await this.load(header.id)
        if (current.validBytes !== current.totalBytes) throw new Error('Session 日志尾部不完整，请重新打开会话')
        const snapshot = snapshotJsonValue(events)
        if (!snapshot || snapshot.some((event, i) => !isSessionEvent(event, current.events.length + i))) throw new Error('Session 事件无效或序号不连续')
        if (!snapshot.length) return
        const file = await open(join(this.directory(header.id), FILENAME), 'r+')
        const size = (await file.stat()).size
        try {
          const bytes = Buffer.from(snapshot.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
          let written = 0
          while (written < bytes.length) {
            const result = await file.write(bytes, written, bytes.length - written, size + written)
            if (result.bytesWritten === 0) throw new Error('Session 写入未取得进展')
            written += result.bytesWritten
          }
          await file.sync()
        } catch (error) {
          try { await file.truncate(size); await file.sync() } catch (rollback) { throw new AggregateError([error, rollback], 'Session 写入和回滚失败') }
          throw error
        } finally { await file.close() }
      },
      flush: async () => {
        assertOpen()
        if (access !== 'write') throw new Error('Session 句柄只读')
        const writer = this.writers.get(header.id)
        if (writer?.handle === handle) await this.drain(writer, true)
        const file = await open(join(this.directory(header.id), FILENAME), 'r+')
        try { await file.sync() } finally { await file.close() }
      },
      close: async () => {
        if (closed) return
        if (access === 'write') {
          const writer = this.writers.get(header.id)
          if (writer?.handle === handle) await this.drain(writer, true)
          await handle.flush()
          if (writer?.handle === handle) this.writers.delete(header.id)
        }
        closed = true
        this.handles.delete(handle)
      },
    }
    this.handles.add(handle)
    if (access === 'write') this.writers.set(header.id, { handle, pending: [], failed: false })
    return handle
  }

  private async flushSession(session: { readonly id: string }): Promise<void> {
    const writer = this.writers.get(session.id)
    if (!writer) return
    await this.drain(writer, true)
    await writer.handle.flush()
  }

  private async drain(writer: { handle: SessionHandle; pending: SessionEvent[]; active?: Promise<void>; failed: boolean }, retry = false): Promise<void> {
    if (writer.active) {
      await writer.active
      if (!writer.pending.length) return
    }
    if (writer.failed && !retry) return
    writer.failed = false
    const operation = (async () => {
      while (writer.pending.length) {
        const batch = writer.pending.slice()
        await writer.handle.append(batch)
        writer.pending.splice(0, batch.length)
      }
    })()
    writer.active = operation
    try { await operation } catch (error) { writer.failed = true; throw error } finally { writer.active = undefined }
  }
}

/** 在 Cordis 作用域中装配 JSONL 后端。 */
export const jsonlSessionPersistencePlugin = Object.assign(
  function jsonlSessionPersistencePlugin(ctx: Context, config: JsonlSessionPersistenceConfig): void {
    new JsonlSessionPersistence(ctx, config)
  },
  { provide: 'sessionPersistence' },
)

function isMissingCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isSessionEvent(value: unknown, seq: number): value is SessionEvent {
  if (!isRecord(value) || typeof value.type !== 'string' || !TYPES.has(value.type)
    || value.seq !== seq || typeof value.time !== 'number' || !Number.isSafeInteger(value.time) || value.time < 0
    || !isRecord(value.data) || snapshotJsonValue(value) === undefined) return false
  const data = value.data
  if (value.type === 'user/message') return isMessage(data, 'user')
  if (!positiveInteger(data.turn)) return false
  if (value.type === 'turn/start') return true
  if (value.type === 'turn/end') return isRecord(data.reason) && typeof data.reason.kind === 'string'
    && ['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'max-steps', 'interrupted'].includes(data.reason.kind)
    && (data.reason.kind !== 'aborted' || ['user', 'parent', 'disposed'].includes(String(data.reason.reason)))
    && (data.reason.kind !== 'error' || typeof data.reason.message === 'string')
    && (data.reason.kind !== 'max-steps' || positiveInteger(data.reason.maxSteps))
  if (!positiveInteger(data.step)) return false
  if (value.type === 'step/start' || value.type === 'step/end') return true
  if (value.type === 'tool/call') return typeof data.callId === 'string' && typeof data.name === 'string' && typeof data.arguments === 'string'
  if (value.type === 'system/message') return isMessage(data.message, 'system')
  if (value.type === 'assistant/message') return isMessage(data.message, 'assistant')
  return isMessage(data.message, 'user') && isRecord(data.message.source) && data.message.source.kind === 'tool'
    && typeof data.message.source.callId === 'string'
    && (data.error === undefined || isRecord(data.error) && typeof data.error.name === 'string' && typeof data.error.code === 'string')
}
function positiveInteger(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function isMessage(value: unknown, role: string): value is Record<string, unknown> {
  return isRecord(value) && value.role === role && typeof value.id === 'string' && isRecord(value.source)
    && typeof value.source.kind === 'string' && Array.isArray(value.content) && value.content.every(isContentBlock)
}
function isContentBlock(value: unknown): boolean {
  if (!isRecord(value)) return false
  switch (value.type) {
    case 'text': case 'reasoning': return typeof value.text === 'string'
    case 'tool-call': return typeof value.id === 'string' && typeof value.name === 'string' && typeof value.arguments === 'string'
    case 'tool-result': return typeof value.toolCallId === 'string' && Array.isArray(value.content)
      && value.content.every(isContentBlock) && (value.isError === undefined || typeof value.isError === 'boolean')
    case 'image': case 'file': return isRecord(value.attachment)
    default: return false
  }
}
