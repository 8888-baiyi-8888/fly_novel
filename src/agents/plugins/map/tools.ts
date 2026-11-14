import { defineTool, type ParameterSchemaSpec, type ToolAgentIdentity, type ToolDefinition, type ToolRunContext } from '@fly-novel/tools'
import { z } from 'zod'
import { mapConnectionSchema, mapPlaceSchema, worldMapSchema } from './format.js'
import { MapStore, MapStoreError } from './store.js'
import { MapQueries, ancestorSchema, areaSchema, connectionSearchSchema, coordinateSchema, searchSchema, treeSchema, id } from './query.js'

const overviewInput = z.object({ name: worldMapSchema.shape.name, description: worldMapSchema.shape.description, scale: worldMapSchema.shape.scale, layers: worldMapSchema.shape.layers, orientation: worldMapSchema.shape.orientation, reserved: worldMapSchema.shape.reserved }).strict()
const placeInput = z.object({ name: mapPlaceSchema.shape.name, aliases: mapPlaceSchema.shape.aliases, description: mapPlaceSchema.shape.description, detailLevel: mapPlaceSchema.shape.detailLevel, parents: mapPlaceSchema.shape.parents, reserved: mapPlaceSchema.shape.reserved }).strict()
const connectionInput = z.object({ fromId: mapConnectionSchema.shape.fromId, toId: mapConnectionSchema.shape.toId, direction: mapConnectionSchema.shape.direction, mode: mapConnectionSchema.shape.mode, description: mapConnectionSchema.shape.description, distance: mapConnectionSchema.shape.distance, duration: mapConnectionSchema.shape.duration, conditions: mapConnectionSchema.shape.conditions }).strict()
const idInput = z.object({ id }).strict()
const updateInput = z.object({ id, version: z.string().min(1), content: connectionInput }).strict()
const str = { type: 'string' } as const
const requiredString = { type: 'string', required: true } as const
const names = { type: 'array', items: { type: 'string' }, required: true } as const
const rectangle = { type: 'array', items: { type: 'number' }, description: '按 [左, 上, 右, 下] 表示的矩形' } as const
const rectangles = { type: 'array', items: rectangle, required: true } as const
const scale = { type: 'object', additionalProperties: false, required: true, properties: { width: { type: 'number', required: true }, height: { type: 'number', required: true }, unit: requiredString } } as const
const layers = { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { id: requiredString, name: requiredString, description: str } } } as const
const parents = { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
  layerId: requiredString, parent: { type: 'object', required: true, additionalProperties: false, properties: { kind: { type: 'string', enum: ['world', 'place'], required: true }, id: str } },
  localBoxes: rectangles, frameBox: { oneOf: [rectangle, { type: 'null' }], required: true }, coverage: { type: 'string', enum: ['partial', 'complete'], required: true },
} } } as const
const measure = { type: 'object', additionalProperties: false, properties: { value: { type: 'number', required: true }, unit: requiredString } } as const
const connectionFields = { fromId: requiredString, toId: requiredString, direction: { type: 'string', enum: ['one-way', 'two-way'], required: true }, mode: requiredString, description: requiredString, distance: measure, duration: measure, conditions: str } as const
const content = { type: 'object', additionalProperties: false, required: true, properties: connectionFields } as const
const page = { offset: { type: 'integer' }, limit: { type: 'integer' }, version: str } as const
const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }

/** 定义属于同一地图插件的工具；绑定身份和存储均由可信应用提供。 */
export function createMapTools(store: MapStore, identity: ToolAgentIdentity, access: 'read-only' | 'read-write'): ToolDefinition[] {
  if (!identity || (access !== 'read-only' && access !== 'read-write')) throw new Error('地图工具需要可信身份和访问模式')
  if (access === 'read-write' && !store.writable) throw new MapStoreError('只读存储不能装配地图写工具', 'MAP_FORBIDDEN')
  const query = new MapQueries(store)
  const tool = (name: string, description: string, parameters: ParameterSchemaSpec, run: (args: unknown, context: ToolRunContext) => Promise<unknown>, mutation = false) =>
    defineTool({ name, description, parameters, output, ...(mutation ? { reportOnAbort: true } : {}), async execute(args, context) {
      if (context.agent !== identity) throw new MapStoreError('地图工具身份不匹配', 'MAP_FORBIDDEN')
      try {
        return z.json().parse(await run(args, context))
      } catch (error) {
        if (error instanceof MapStoreError && error.code === 'MAP_COMMIT_UNKNOWN' && error.path) return { status: 'unknown', path: error.path }
        throw error
      }
    } })
  const tools = [
    tool('map_overview_read', '读取世界地图概览和文件版本。', {}, (_, ctx) => store.readOverview(ctx.signal)),
    tool('map_place_read', '按 ID 读取地点完整资料和文件版本。', { id: requiredString }, (args, ctx) => store.readPlace(idInput.parse(args).id, ctx.signal)),
    tool('map_place_search', '按名称、别名、层面或父级查询地点；后续页须使用版本。', { keyword: str, layerId: str, parentId: str, detailLevel: str, ...page }, (args, ctx) => query.search(searchSchema.parse(args), ctx.signal)),
    tool('map_place_children', '按层面查子地点及限深后代；结果同时列出其他父级。', { id: requiredString, layerId: requiredString, depth: { type: 'integer' }, detailLevel: str, ...page }, (args, ctx) => query.children(treeSchema.parse(args), ctx.signal)),
    tool('map_place_ancestors', '按层面查地点祖先和路径。', { id: requiredString, layerId: requiredString, depth: { type: 'integer' }, ...page }, (args, ctx) => query.ancestors(ancestorSchema.parse(args), ctx.signal)),
    tool('map_coordinates_convert', '沿明确的父级路径逐层换算覆盖框或完整地点参考框；路径以父级 ID 或 world 排列。', { id: requiredString, layerId: requiredString, path: names, mode: { type: 'string', enum: ['coverage', 'frame'], required: true } }, (args, ctx) => query.coordinates(coordinateSchema.parse(args), ctx.signal)),
    tool('map_area_search', '按实际覆盖矩形查指定画布中的地点，不将外包框或边缘接触视为面积相交。', { layerId: requiredString, canvas: requiredString, boxes: rectangles, includeTouching: { type: 'boolean' }, ...page }, (args, ctx) => query.area(areaSchema.parse(args), ctx.signal)),
    tool('map_connections_read', '查询地点的入边、出边或全部连通；无记录不代表不通。', { id: requiredString, direction: str, mode: str, ...page }, (args, ctx) => query.connections(connectionSearchSchema.parse(args), ctx.signal)),
  ]
  if (access === 'read-write') tools.push(
    tool('map_overview_create', '创建世界地图概览，比例由本世界地图设置。', { name: requiredString, description: requiredString, scale, layers, orientation: requiredString, reserved: names }, (args, ctx) => store.createOverview(overviewInput.parse(args), ctx.signal), true),
    tool('map_place_create', '创建地点；parents 给出层面、父级、局部矩形和参考框。', { name: requiredString, aliases: names, description: requiredString, detailLevel: { type: 'string', enum: ['unexpanded', 'overview', 'detailed'], required: true }, parents, reserved: names }, (args, ctx) => store.createPlace(placeInput.parse(args), ctx.signal), true),
    tool('map_connection_create', '创建两地点之间的当前连通设定。', connectionFields, (args, ctx) => store.createConnection(connectionInput.parse(args), ctx.signal), true),
    tool('map_connection_update', '按文件版本用完整内容覆盖连通设定。', { id: requiredString, version: requiredString, content }, (args, ctx) => { const q = updateInput.parse(args); return store.updateConnection(q.id, q.version, q.content, ctx.signal) }, true),
  )
  return tools
}
