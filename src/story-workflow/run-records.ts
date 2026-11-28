import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { isMissingStoryFile, publishConvoyRecord, readConvoyRecord } from './convoy-state.js'
import { PlanStore } from './store.js'
import { planInputSchema } from './types.js'

export const storyRunIdSchema = z.string().uuid()
export const storyRunDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const storyRunManifestSchema = z.object({
  formatVersion: z.literal(1), runId: storyRunIdSchema, planId: storyRunIdSchema, rootStoryId: storyRunIdSchema,
  worldId: z.string().min(1), deliveryId: storyRunIdSchema, configuration: storyRunDigestSchema, request: storyRunDigestSchema,
  input: planInputSchema,
  previous: z.object({ runId: storyRunIdSchema, result: storyRunDigestSchema }).strict().optional(),
}).strict().refine(item => new Set([item.runId, item.planId, item.rootStoryId]).size === 3 &&
  'world' in item.input && item.input.world.worldId === item.worldId && item.input.world.deliveryId === item.deliveryId,
  '运行、规划和交付身份不匹配')
export type StoryRunManifest = z.infer<typeof storyRunManifestSchema>

export function runDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** 运行意图及步骤的不可变记录。可信调用方协调同一运行的写入。 */
export async function openStoryRunRecords(root: string, protectedRoots: readonly string[]) {
  await PlanStore.open(root, protectedRoots)
  const canonical = await realpath(root)
  const safeKey = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,175}$/)
  const name = (runId: string, key: string) => `${storyRunIdSchema.parse(runId)}.${safeKey.parse(key)}.run.json`
  async function read<T>(runId: string, key: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const filename = name(runId, key)
    try {
      const value = await readConvoyRecord(canonical, filename,
        z.object({ formatVersion: z.literal(1), runId: storyRunIdSchema, key: safeKey, value: schema }).strict())
      if (value.runId !== runId || value.key !== key) throw new Error('故事运行记录身份不匹配')
      return value.value
    } catch (error) {
      if (isMissingStoryFile(error)) return undefined
      throw error
    }
  }
  return Object.freeze({
    root: canonical, read,
    async save<T>(runId: string, key: string, schema: z.ZodType<T>, item: T): Promise<T> {
      const value = schema.parse(item)
      if (!await publishConvoyRecord(canonical, name(runId, key), { formatVersion: 1, runId, key, value }) &&
        !isDeepStrictEqual(await read(runId, key, schema), value)) throw new Error('同一运行步骤已保存不同内容')
      return value
    },
  })
}
