import { isAbsolute } from 'node:path'
import { deepFreeze, snapshotJsonValue } from '@fly-novel/util'
import { SESSION_FORMAT_VERSION } from '../types/index.ts'
import type { SessionHeader, SessionId } from '../types/index.ts'

/** 校验已分离的会话创建头，并就地深度冻结。 */
export function validateSessionHeader(id: SessionId, input: unknown): SessionHeader {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('会话头必须是普通 JSON 对象')
  }
  const record = input as Record<string, unknown>
  if (Object.hasOwn(record, 'seedLength')) {
    throw new Error('会话头包含无效字段 "seedLength"')
  }
  if (record.version !== SESSION_FORMAT_VERSION) {
    throw new Error(`会话头 version 必须为 ${SESSION_FORMAT_VERSION}，实际为 ${String(record.version)}`)
  }
  if (record.id !== id) {
    throw new Error(`会话头 id "${String(record.id)}" 与会话标识 "${id}" 不一致`)
  }
  if (typeof record.createdAt !== 'number'
    || !Number.isSafeInteger(record.createdAt)
    || record.createdAt < 0) {
    throw new Error('会话头 createdAt 必须为非负安全整数')
  }
  if (record.cwd !== undefined) {
    if (typeof record.cwd !== 'string') throw new Error('会话头 cwd 必须为字符串')
    if (!isAbsolute(record.cwd)) {
      throw new Error(`会话头 cwd 必须为绝对路径，实际为 "${record.cwd}"`)
    }
  }
  if (record.parentSession !== undefined && typeof record.parentSession !== 'string') {
    throw new Error('会话头 parentSession 必须为字符串')
  }
  if (typeof record.isSeeded !== 'boolean') {
    throw new Error('会话头 isSeeded 必须为布尔值')
  }
  if (record.origin !== undefined && record.origin !== 'subagent') {
    throw new Error('会话头 origin 必须为 "subagent"')
  }
  if (record.delegationDepth !== undefined
    && (typeof record.delegationDepth !== 'number' || !Number.isSafeInteger(record.delegationDepth) || record.delegationDepth < 0)) {
    throw new Error('会话头 delegationDepth 必须为非负安全整数')
  }
  if (record.agentPreset !== undefined && typeof record.agentPreset !== 'string') {
    throw new Error('会话头 agentPreset 必须为字符串')
  }
  return deepFreeze(record as unknown as SessionHeader)
}

/** 校验恢复流程独占的持久化会话头，并就地深度冻结。 */
export function validateRestoredSessionHeader(id: SessionId, input: unknown): SessionHeader {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const prototype = Reflect.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('会话头必须是普通 JSON 对象')
    }
  }
  return validateSessionHeader(id, input)
}

/** 复制、校验并冻结会话对外发布的创建元数据。 */
export function snapshotSessionHeader(id: SessionId, source?: SessionHeader): SessionHeader {
  const input: unknown = source === undefined
    ? { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false }
    : source
  const snapshot = snapshotJsonValue(input)
  if (snapshot === undefined) throw new Error('会话头无法无损序列化为 JSON')
  return validateSessionHeader(id, snapshot)
}
