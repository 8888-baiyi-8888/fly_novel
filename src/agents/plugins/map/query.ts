import { createHash } from 'node:crypto'
import { z } from 'zod'
import { mapIdSchema, type MapPlace } from './format.js'
import { MapStore, MapStoreError, type MapSnapshot } from './store.js'

type Box = [number, number, number, number]
type Parent = MapPlace['parents'][number]
const pageSchema = z.object({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20), version: z.string().min(1).optional() }).strict()
export const queryPageSchema = pageSchema
export const id = mapIdSchema
export const layer = z.string().min(1)
export const detail = z.enum(['unexpanded', 'overview', 'detailed'])
export const parentId = z.union([mapIdSchema, z.literal('world')])
const box = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]).refine(([l,t,r,b]) => l < r && t < b)
export const boxes = z.array(box).min(1).max(100)
export const searchSchema = pageSchema.extend({ keyword: z.string().min(1).optional(), layerId: layer.optional(), parentId: parentId.optional(), detailLevel: detail.optional() }).strict()
export const treeSchema = pageSchema.extend({ id: parentId, layerId: layer, depth: z.number().int().min(1).max(32).default(1), detailLevel: detail.optional() }).strict()
export const ancestorSchema = pageSchema.extend({ id, layerId: layer, depth: z.number().int().min(1).max(32).default(1) }).strict()
export const coordinateSchema = z.object({ id, layerId: layer, path: z.array(parentId).min(1).max(32), mode: z.enum(['coverage', 'frame']) }).strict()
export const areaSchema = pageSchema.extend({ layerId: layer, canvas: parentId, boxes, includeTouching: z.boolean().default(false) }).strict()
export const connectionSearchSchema = pageSchema.extend({ id, direction: z.enum(['in', 'out', 'any']).default('any'), mode: z.string().min(1).optional() }).strict()

function page<T>(snapshot: MapSnapshot, items: T[], input: z.infer<typeof pageSchema>) {
  const { offset: _offset, limit: _limit, version: _version, ...filters } = input
  const version = createHash('sha256').update(JSON.stringify([snapshot.version, filters])).digest('hex')
  if (input.offset > 0 && !input.version) throw new MapStoreError('后续页需要查询版本', 'MAP_CONFLICT')
  if (input.version && input.version !== version) throw new MapStoreError('地图资料或查询条件已变化，请重新查询', 'MAP_CONFLICT')
  const next = input.offset + input.limit
  return { items: items.slice(input.offset, next), nextOffset: next < items.length ? next : null, version }
}
const placeIndexes = new WeakMap<MapSnapshot, Map<string, MapPlace>>()
function find(s: MapSnapshot, id: string) {
  let index = placeIndexes.get(s)
  if (!index) { index = new Map(s.places.map(entry => [entry.document.id, entry.document])); placeIndexes.set(s, index) }
  const place = index.get(id)
  if (!place) throw new MapStoreError('地点不存在', 'MAP_NOT_FOUND')
  return place
}
function ensureLayer(s: MapSnapshot, layerId: string) {
  if (!s.overview.document.layers.some(item => item.id === layerId)) throw new MapStoreError('地图层面不存在', 'MAP_NOT_FOUND')
}
function parentKey(p: Parent): string { return p.parent.kind === 'world' ? 'world' : p.parent.id }
function transform([l,t,r,b]: Box, [x,y,x2,y2]: Box): Box {
  return [x + l * (x2-x)/1000, y + t * (y2-y)/1000, x + r * (x2-x)/1000, y + b * (y2-y)/1000]
}
function clip(a: Box, b: Box): Box | undefined {
  const result: Box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]
  return result[0] < result[2] && result[1] < result[3] ? result : undefined
}
function roundBox(box: Box): Box { return box.map(value => Math.round(value * 1e6) / 1e6) as Box }
function intersection(a: Box, b: Box): 'overlap' | 'touching' | 'none' {
  const x = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
  const y = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
  if (x > 1e-6 && y > 1e-6) return 'overlap'
  if (x >= -1e-6 && y >= -1e-6) return 'touching'
  return 'none'
}

/** 逐个父级关系换算，不把分离范围合并为包围框。 */
function convert(s: MapSnapshot, input: z.infer<typeof coordinateSchema>, round = true) {
  ensureLayer(s, input.layerId)
  let current = find(s, input.id)
  let result: Box[] | undefined
  let complete = true
  for (const [index, parent] of input.path.entries()) {
    const edge = current.parents.find(item => item.layerId === input.layerId && parentKey(item) === parent)
    if (!edge) throw new MapStoreError('指定路径不是地点父级关系', 'MAP_INVALID_DOCUMENT')
    if (index === 0) {
      result = input.mode === 'frame' ? (edge.frameBox ? [edge.frameBox] : []) : edge.localBoxes
      complete = input.mode === 'frame' ? edge.frameBox !== null : edge.coverage === 'complete' && edge.localBoxes.length > 0
    } else {
      if (!edge.frameBox) return { boxes: [], complete: false, reason: '父地点缺少画布参考框', path: input.path }
      result = result!.map(value => transform(value, edge.frameBox!))
      if (input.mode === 'coverage' && edge.localBoxes.length) result = result.flatMap(value => edge.localBoxes.flatMap(parentBox => { const part = clip(value, parentBox); return part ? [part] : [] }))
      if (input.mode === 'coverage' && !edge.localBoxes.length) complete = false
      complete = complete && edge.coverage === 'complete'
    }
    if (parent === 'world') {
      if (index !== input.path.length - 1) throw new MapStoreError('世界画布必须是路径终点', 'MAP_INVALID_DOCUMENT')
    } else current = find(s, parent)
  }
  const converted = round ? (result ?? []).map(roundBox) : (result ?? [])
  const world = input.path.at(-1) === 'world'
  const scale = s.overview.document.scale
  return { boxes: converted, complete, path: input.path, ...(world ? { physicalBoxes: converted.map(([l,t,r,b]): Box => roundBox([l*scale.width/1000,t*scale.height/1000,r*scale.width/1000,b*scale.height/1000])), unit: scale.unit } : {}) }
}

function compareFrames(s: MapSnapshot, id: string, layerId: string, target: string, signal?: AbortSignal): 'consistent' | 'incomplete' {
  const pending: { id: string; path: string[] }[] = [{ id, path: [] }]
  const frames: Box[] = []; let complete = true; let visited = 0
  while (pending.length) {
    signal?.throwIfAborted(); const node = pending.pop()!
    if (++visited > 10000) throw new MapStoreError('地点路径数量超过限制', 'MAP_LIMIT')
    if (node.path.length >= 32) { complete = false; continue }
    for (const edge of find(s, node.id).parents.filter(item => item.layerId === layerId)) {
      const parent = parentKey(edge); const path = [...node.path, parent]
      if (parent === target) {
        const value = convert(s, { id, layerId, path, mode: 'frame' }, false)
        if (value.boxes.length) frames.push(value.boxes[0]); else complete = false
      } else if (parent !== 'world') pending.push({ id: parent, path })
    }
  }
  if (frames.length > 1 && frames.slice(1).some(frame => frame.some((coordinate, index) => Math.abs(coordinate - frames[0][index]) > 1e-6))) throw new MapStoreError('不同父级路径的地点画布位置不一致', 'MAP_CONFLICT')
  return complete ? 'consistent' : 'incomplete'
}

/** 在可信 MapStore 上执行可重建的查询，所有扫描错误均向调用方报告。 */
export class MapQueries {
  constructor(private readonly store: MapStore) {}

  async search(input: z.infer<typeof searchSchema>, signal?: AbortSignal) {
    const q = searchSchema.parse(input); const s = await this.store.snapshot(signal)
    if (q.layerId) ensureLayer(s, q.layerId)
    if (q.parentId && q.parentId !== 'world') find(s, q.parentId)
    const items = s.places.map(entry => entry.document).filter(p => (!q.keyword || [p.name, ...p.aliases].some(name => name.includes(q.keyword!))) &&
      (!q.detailLevel || p.detailLevel === q.detailLevel) && p.parents.some(edge => (!q.layerId || edge.layerId === q.layerId) && (!q.parentId || parentKey(edge) === q.parentId)))
      .map(p => ({ id: p.id, name: p.name, aliases: p.aliases, detailLevel: p.detailLevel, reviewStatus: p.reviewStatus, parents: p.parents.map(edge => ({ layerId: edge.layerId, parent: edge.parent })) }))
    return { ...page(s, items, q), complete: true }
  }

  async children(input: z.infer<typeof treeSchema>, signal?: AbortSignal) {
    const q = treeSchema.parse(input); const s = await this.store.snapshot(signal); ensureLayer(s, q.layerId)
    if (q.id !== 'world') find(s, q.id)
    const found = new Map<string, { place: MapPlace; paths: string[][] }>()
    let frontier: { id: string; path: string[] }[] = [{ id: q.id, path: [q.id] }]
    let truncated = false
    for (let depth = 0; frontier.length && depth < q.depth; depth++) {
      const next: typeof frontier = []
      for (const item of frontier) for (const entry of s.places) {
        signal?.throwIfAborted(); const p = entry.document
        if (!p.parents.some(edge => edge.layerId === q.layerId && parentKey(edge) === item.id)) continue
        const path = [...item.path, p.id]; const existing = found.get(p.id)
        if (existing) existing.paths.push(path); else found.set(p.id, { place: p, paths: [path] })
        next.push({ id: p.id, path })
        if (next.length > 10000) throw new MapStoreError('地点路径数量超过限制', 'MAP_LIMIT')
      }
      frontier = next
    }
    if (frontier.some(item => s.places.some(entry => entry.document.parents.some(edge => edge.layerId === q.layerId && parentKey(edge) === item.id)))) truncated = true
    const items = [...found.values()].filter(({ place }) => !q.detailLevel || place.detailLevel === q.detailLevel).map(({ place, paths }) => ({ id: place.id, name: place.name, detailLevel: place.detailLevel, paths, parents: place.parents.map(edge => ({ layerId: edge.layerId, parent: edge.parent })) }))
    return { ...page(s, items, q), complete: !truncated, truncated }
  }

  async ancestors(input: z.infer<typeof ancestorSchema>, signal?: AbortSignal) {
    const q = ancestorSchema.parse(input); const s = await this.store.snapshot(signal); ensureLayer(s, q.layerId); find(s, q.id)
    let frontier = [{ id: q.id, path: [q.id] }]; const items: { id: string; name: string; path: string[] }[] = []
    let truncated = false
    for (let depth = 0; frontier.length && depth < q.depth; depth++) {
      const next: typeof frontier = []
      for (const node of frontier) for (const edge of find(s, node.id).parents.filter(p => p.layerId === q.layerId)) {
        signal?.throwIfAborted(); const parent = parentKey(edge); const path = [...node.path, parent]
        items.push({ id: parent, name: parent === 'world' ? s.overview.document.name : find(s, parent).name, path })
        if (parent !== 'world') next.push({ id: parent, path })
        if (items.length > 10000) throw new MapStoreError('地点路径数量超过限制', 'MAP_LIMIT')
      }
      frontier = next
    }
    truncated = frontier.some(node => find(s, node.id).parents.some(edge => edge.layerId === q.layerId))
    return { ...page(s, items, q), complete: !truncated, truncated }
  }

  async coordinates(input: z.infer<typeof coordinateSchema>, signal?: AbortSignal) {
    const q = coordinateSchema.parse(input); const s = await this.store.snapshot(signal)
    const converted = convert(s, q)
    return { ...converted, consistency: compareFrames(s, q.id, q.layerId, q.path[q.path.length - 1], signal), version: s.version }
  }

  async connections(input: z.infer<typeof connectionSearchSchema>, signal?: AbortSignal) {
    const q = connectionSearchSchema.parse(input); const s = await this.store.snapshot(signal); find(s, q.id)
    const items = s.connections.filter(({ document: c }) => (!q.mode || c.mode === q.mode) && (q.direction === 'any' ? c.fromId === q.id || c.toId === q.id : q.direction === 'out' ? c.fromId === q.id || (c.direction === 'two-way' && c.toId === q.id) : c.toId === q.id || (c.direction === 'two-way' && c.fromId === q.id)))
    return { ...page(s, items, q), complete: true, absenceMeansInaccessible: false }
  }

  async area(input: z.infer<typeof areaSchema>, signal?: AbortSignal) {
    const q = areaSchema.parse(input); const s = await this.store.snapshot(signal); ensureLayer(s, q.layerId)
    if (q.canvas !== 'world') find(s, q.canvas)
    const items: { id: string; name: string; relation: 'overlap' | 'touching'; paths: string[][] }[] = []
    let complete = true; let pathsVisited = 0
    for (const { document: place } of s.places) {
      let relation: 'overlap' | 'touching' | 'none' = 'none'; const matched: string[][] = []
      let frontier: { id: string; path: string[] }[] = [{ id: place.id, path: [] }]
      while (frontier.length) {
        const node = frontier.pop()!; signal?.throwIfAborted()
        if (++pathsVisited > 100000) throw new MapStoreError('区域搜索路径数量超过限制', 'MAP_LIMIT')
        if (node.path.length >= 32) { complete = false; continue }
        for (const edge of find(s, node.id).parents.filter(p => p.layerId === q.layerId)) {
          const parent = parentKey(edge); const path = [...node.path, parent]
          if (parent === q.canvas) {
            if (compareFrames(s, place.id, q.layerId, q.canvas, signal) === 'incomplete') complete = false
            const result = convert(s, { id: place.id, layerId: q.layerId, path, mode: 'coverage' })
            if (!result.complete) complete = false
            const hit = result.boxes.some(a => q.boxes.some(b => intersection(a, b) === 'overlap')) ? 'overlap' : result.boxes.some(a => q.boxes.some(b => intersection(a, b) === 'touching')) ? 'touching' : 'none'
            if (hit !== 'none') { matched.push(path); if (hit === 'overlap' || relation === 'none') relation = hit }
          } else if (parent !== 'world') frontier.push({ id: parent, path })
        }
      }
      if (relation === 'overlap' || (relation === 'touching' && q.includeTouching)) items.push({ id: place.id, name: place.name, relation, paths: matched })
    }
    return { ...page(s, items, q), complete }
  }
}
