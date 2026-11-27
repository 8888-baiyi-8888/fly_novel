import { randomUUID } from 'node:crypto'
import { link, lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { sceneEventDigestSchema } from './scene-event.js'
import { parseStrictJson } from './types.js'

const text = z.string().trim().min(1).max(2000)
const uuid = z.string().uuid()
export const convoyIdentitySchema = z.object({ worldId: text, convoyId: uuid }).strict()
export const convoyBaselineSourceSchema = z.object({ sourceId: text, version: text }).strict()
export const convoyBaselineSchema = convoyIdentitySchema.extend({ formatVersion: z.literal(1), revision: z.literal(0), status: z.literal('arrived'), source: convoyBaselineSourceSchema })
export type ConvoyBaseline = z.infer<typeof convoyBaselineSchema>
export const convoyProposalSchema = convoyIdentitySchema.extend({
  operationId: uuid, expectedRevision: z.number().int().nonnegative(), locationId: text,
  evidence: z.object({ runId: uuid, storyId: uuid, sceneId: text, eventId: sceneEventDigestSchema,
    sequence: z.number().int().positive(), actionIndex: z.number().int().nonnegative() }).strict(),
})
export type ConvoyProposal = z.infer<typeof convoyProposalSchema>
export const convoyChangeSchema = z.object({ formatVersion: z.literal(1), proposal: convoyProposalSchema,
  expectedDigest: sceneEventDigestSchema, eventDigest: sceneEventDigestSchema, authorization: text,
}).strict()
export type ConvoyChange = z.infer<typeof convoyChangeSchema>
export const convoyCommittedSchema = convoyIdentitySchema.extend({
  formatVersion: z.literal(1), revision: z.literal(1), status: z.literal('waiting'), locationId: text, change: convoyChangeSchema,
}).refine(item => item.change.proposal.worldId === item.worldId && item.change.proposal.convoyId === item.convoyId &&
  item.change.proposal.locationId === item.locationId && item.change.proposal.expectedRevision === 0, '已应用商队操作与状态不匹配')
export type ConvoyCommitted = z.infer<typeof convoyCommittedSchema>
export type ConvoyState = ConvoyBaseline | ConvoyCommitted
export type ConvoyReceipt =
  | { status: 'applied'; operationId: string; state: ConvoyCommitted }
  | { status: 'not-applied' | 'conflict' | 'unknown'; operationId: string; reason: string }

const maxBytes = 1024 * 1024

export function isMissingStoryFile(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** 只读所选真实目录的普通有界文件，发布时由同目录文件原子占用最终名称。 */
export async function readConvoyRecord<T>(root: string, name: string, schema: z.ZodType<T>): Promise<T> {
  const path = join(root, name)
  const before = await lstat(path)
  if (!before.isFile() || await realpath(path) !== path || before.size > maxBytes) throw new Error('商队状态记录文件无效')
  const bytes = await readFile(path)
  const after = await lstat(path)
  if (bytes.length > maxBytes || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('商队状态记录读取期间变化')
  return schema.parse(parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
}

export async function publishConvoyRecord(root: string, name: string, record: unknown): Promise<boolean> {
  if (await realpath(root) !== root) throw new Error('商队状态根已变化')
  const text = `${JSON.stringify(record)}\n`
  if (Buffer.byteLength(text) > maxBytes) throw new Error('商队状态记录超过大小限制')
  const temporary = join(root, `.convoy-${randomUUID()}.tmp`)
  await writeFile(temporary, text, { flag: 'wx' })
  try {
    await link(temporary, join(root, name))
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false
    throw error
  } finally { await unlink(temporary) }
}

export function convoyOperationName(operationId: string) {
  return `operation-${uuid.parse(operationId)}.json`
}
