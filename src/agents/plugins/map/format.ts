import { parseDocument } from 'yaml'
import { z } from 'zod'

const nonEmpty = z.string().trim().min(1)
export const mapIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const finite = z.number().finite()
const boxSchema = z.tuple([finite, finite, finite, finite]).refine(([left, top, right, bottom]) => left < right && top < bottom, '矩形必须具有正宽高')
const localBoxSchema = boxSchema.refine(([left, top, right, bottom]) => left >= 0 && top >= 0 && right <= 1000 && bottom <= 1000, '局部范围框必须位于画布内')
const parentSchema = z.object({
  layerId: nonEmpty,
  parent: z.discriminatedUnion('kind', [z.object({ kind: z.literal('world') }).strict(), z.object({ kind: z.literal('place'), id: mapIdSchema }).strict()]),
  localBoxes: z.array(localBoxSchema),
  frameBox: boxSchema.nullable(),
  coverage: z.enum(['partial', 'complete']),
}).strict().superRefine((value, context) => {
  if (value.coverage === 'complete' && value.localBoxes.length === 0) context.addIssue({ code: 'custom', message: '范围为空时不能标记完整' })
  if (value.frameBox) {
    const [left, top, right, bottom] = value.frameBox
    if (value.localBoxes.some(([l, t, r, b]) => l < left || t < top || r > right || b > bottom)) {
      context.addIssue({ code: 'custom', message: '局部范围不能超出地点参考框' })
    }
  }
})

export const worldMapSchema = z.object({
  formatVersion: z.literal(1), worldId: nonEmpty, name: nonEmpty, description: z.string(), reviewStatus: z.literal('suggested'),
  scale: z.object({ width: finite.positive(), height: finite.positive(), unit: nonEmpty }).strict(),
  layers: z.array(z.object({ id: nonEmpty, name: nonEmpty, description: z.string().optional() }).strict()).min(1),
  orientation: nonEmpty, reserved: z.array(nonEmpty),
}).strict().superRefine((value, context) => {
  if (new Set(value.layers.map(layer => layer.id)).size !== value.layers.length) context.addIssue({ code: 'custom', message: '地图层面 ID 重复' })
})

export const mapPlaceSchema = z.object({
  formatVersion: z.literal(1), worldId: nonEmpty, id: mapIdSchema, name: nonEmpty, aliases: z.array(nonEmpty), description: z.string(),
  reviewStatus: z.literal('suggested'), detailLevel: z.enum(['unexpanded', 'overview', 'detailed']),
  parents: z.array(parentSchema).min(1), reserved: z.array(nonEmpty),
}).strict().superRefine((value, context) => {
  const keys = value.parents.map(item => JSON.stringify([item.layerId, item.parent.kind, item.parent.kind === 'place' ? item.parent.id : null]))
  if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: '地点父级关联重复' })
  if (value.parents.some(item => item.parent.kind === 'place' && item.parent.id === value.id)) context.addIssue({ code: 'custom', message: '地点不能以自身为父级' })
})

export const mapConnectionSchema = z.object({
  formatVersion: z.literal(1), worldId: nonEmpty, id: mapIdSchema, fromId: mapIdSchema, toId: mapIdSchema,
  direction: z.enum(['one-way', 'two-way']), mode: nonEmpty, description: z.string(),
  distance: z.object({ value: finite.nonnegative(), unit: nonEmpty }).strict().optional(),
  duration: z.object({ value: finite.nonnegative(), unit: nonEmpty }).strict().optional(),
  conditions: z.string().optional(),
}).strict().refine(value => value.fromId !== value.toId, '连通起点和终点不能相同')

export type WorldMap = z.infer<typeof worldMapSchema>
export type MapPlace = z.infer<typeof mapPlaceSchema>
export type MapConnection = z.infer<typeof mapConnectionSchema>

function strictJson(text: string): unknown {
  const value: unknown = JSON.parse(text)
  const parsed = parseDocument(text, { uniqueKeys: true })
  if (parsed.errors.length) throw new Error('JSON 包含重复键或无效结构', { cause: parsed.errors[0] })
  return value
}

/** 严格解析带版本的世界地图 JSON；拒绝重复键、未知字段和未知版本。 */
export function parseWorldMap(text: string): WorldMap { return worldMapSchema.parse(strictJson(text)) }
/** 严格解析带版本的地点 JSON；拒绝重复键、未知字段和无效范围。 */
export function parseMapPlace(text: string): MapPlace { return mapPlaceSchema.parse(strictJson(text)) }
/** 严格解析带版本的连通 JSON；拒绝重复键、未知字段和无效端点。 */
export function parseMapConnection(text: string): MapConnection { return mapConnectionSchema.parse(strictJson(text)) }

/** 将已校验的地图文档序列化为可读的 UTF-8 JSON。 */
export function formatMapDocument(value: WorldMap | MapPlace | MapConnection): string {
  const schema = 'fromId' in value ? mapConnectionSchema : 'parents' in value ? mapPlaceSchema : worldMapSchema
  return `${JSON.stringify(schema.parse(value), null, 2)}\n`
}
