import { createHash } from 'node:crypto'
import { readdir, realpath } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { publishConvoyRecord, readConvoyRecord } from './convoy-state.js'
import { PlanStore } from './store.js'

const id = z.string().uuid()
const text = z.string().trim().min(1)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const minute = z.number().int().nonnegative()
const range = { start: minute, end: minute }
const position = z.object({ characterId: id, locationId: text }).strict()
const scene = z.object({ storyId: id, sceneId: text, setupDigest: hash }).strict()
const claim = scene.extend({ token: id }).strict()
const dependency = z.object({ slotId: id, kind: z.enum(['order', 'result']) }).strict()
const target = z.object({ id, mode: z.enum(['read', 'write']) }).strict()

export const scheduleSlotSchema = z.object({
  id, runId: id, ...range, locationId: text, characters: z.array(id), dependencies: z.array(dependency),
  targets: z.array(target),
}).strict()
export type ScheduleSlot = z.infer<typeof scheduleSlotSchema>

const settlement = z.object({
  kind: z.literal('settled'), evidenceDigest: hash, positions: z.array(position),
}).strict()
const resolution = z.discriminatedUnion('kind', [
  settlement, z.object({ kind: z.literal('cancelled'), reason: text }).strict(),
  z.object({ kind: z.literal('uncertain'), reason: text }).strict(),
])
const scheduled = scheduleSlotSchema.extend({ claim: claim.optional(), resolution: resolution.optional() }).strict()
const workspace = z.object({
  id, ...range, sealed: z.boolean(), positions: z.array(position), slots: z.array(scheduled),
}).strict()
export const worldScheduleSchema = z.object({
  formatVersion: z.literal(1), worldId: text, epoch: text, revision: minute,
  previous: hash.nullable(), reason: text, window: workspace,
}).strict().superRefine((value, ctx) => {
  const { window } = value
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
  if ((value.revision === 0) !== (value.previous === null) || window.start >= window.end) issue('世界时间窗或版本无效')
  if (new Set(window.positions.map(item => item.characterId)).size !== window.positions.length) issue('角色起始位置重复')
  const byId = new Map(window.slots.map(item => [item.id, item]))
  if (byId.size !== window.slots.length) issue('排期身份重复')
  const identities = new Set<string>()
  for (const slot of window.slots) {
    if (slot.start < window.start || slot.start >= slot.end || slot.end > window.end) issue('排期区间超出时间窗或方向无效')
    if (new Set(slot.characters).size !== slot.characters.length || new Set(slot.targets.map(item => item.id)).size !== slot.targets.length ||
      new Set(slot.dependencies.map(item => item.slotId)).size !== slot.dependencies.length) issue('排期资源或依赖重复')
    for (const dependency of slot.dependencies) {
      const before = byId.get(dependency.slotId)
      if (!before || before.end > slot.start) issue('排期前置不存在、在未来或形成循环')
    }
    if (slot.claim) {
      const key = JSON.stringify([slot.runId, slot.claim.storyId, slot.claim.sceneId])
      if (identities.has(key) || !window.sealed) issue('已领取场景身份重复或时间窗未批准')
      identities.add(key)
    }
    if (slot.resolution?.kind === 'settled') {
      const known = slot.resolution.positions.map(item => item.characterId)
      if (!slot.claim || known.length !== slot.characters.length || new Set(known).size !== known.length ||
        !known.every(characterId => slot.characters.includes(characterId))) issue('结算角色及领取记录不匹配')
    }
    if (slot.resolution?.kind === 'uncertain' && !slot.claim) issue('待核查的排期缺少领取')
  }
})
export type WorldSchedule = z.infer<typeof worldScheduleSchema>
export type ScheduledScene = WorldSchedule['window']['slots'][number]

export function scheduleDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** 在独立目录保存不可变的世界排期修订。调用方在同一可信进程内协调变更。 */
export async function openWorldScheduleStore(root: string, protectedRoots: readonly string[], worldId: string) {
  await PlanStore.open(root, protectedRoots)
  const canonical = await realpath(root)
  const prefix = `schedule-${scheduleDigest(worldId)}-`
  const path = (revision: number) => `${prefix}${revision}.json`
  async function read(revision: number) {
    const value = await readConvoyRecord(canonical, path(minute.parse(revision)), worldScheduleSchema)
    if (value.worldId !== worldId || value.revision !== revision) throw new Error('世界排期身份不匹配')
    return value
  }
  async function latest() {
    const revisions = (await readdir(canonical)).filter(name => name.startsWith(prefix)).map(name => {
      const match = /^(0|[1-9][0-9]*)\.json$/.exec(name.slice(prefix.length))
      if (!match) throw new Error('世界排期文件编号无效')
      return minute.parse(Number(match[1]))
    }).sort((a, b) => a - b)
    let previous: WorldSchedule | undefined
    for (const [index, revision] of revisions.entries()) {
      if (index !== revision) throw new Error('世界排期历史存在缺口')
      const record = await read(revision)
      if (record.previous !== (previous ? scheduleDigest(previous) : null)) throw new Error('世界排期历史版本不衔接')
      previous = record
    }
    return previous
  }
  return Object.freeze({
    root: canonical, read, latest,
    async save(next: WorldSchedule) {
      const value = worldScheduleSchema.parse(next)
      const previous = await latest()
      if (value.worldId !== worldId || value.revision !== (previous?.revision ?? -1) + 1 ||
        value.previous !== (previous ? scheduleDigest(previous) : null)) throw new Error('世界排期预期版本已变化')
      if (previous?.epoch !== undefined && previous.epoch !== value.epoch) throw new Error('世界时间基准已固定')
      if (!await publishConvoyRecord(canonical, path(value.revision), value) && !isDeepStrictEqual(await read(value.revision), value)) {
        throw new Error('世界排期版本已被占用')
      }
      return value
    },
  })
}
