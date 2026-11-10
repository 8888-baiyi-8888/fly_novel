import { parseDocument, stringify } from 'yaml'
import { z } from 'zod'

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const categoryValue = z.object({ id: z.string().trim().min(1), name: z.string().trim().min(1) }).strict()
const categories = z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.array(categoryValue)).superRefine((value, context) => {
  for (const [key, entries] of Object.entries(value)) {
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) {
      context.addIssue({ code: 'custom', message: `分类 ${key} 存在重复 ID` })
    }
  }
})

/** 当前角色资料和待审候选共用的持久化元数据。 */
export const characterMetadataSchema = z.object({
  formatVersion: z.literal(1),
  id: uuid,
  name: z.string().trim().min(1),
  summary: z.string(),
  contentStatus: z.enum(['suggested', 'confirmed', 'pending']),
  categories,
}).strict()
export type CharacterMetadata = z.infer<typeof characterMetadataSchema>
export interface CharacterDocument { metadata: CharacterMetadata; body: string }

const requirementSchema = z.object({
  id: uuid,
  status: z.enum(['undetermined', 'needed', 'existing', 'created', 'deferred']),
  description: z.string().trim().min(1),
  sources: z.array(z.object({ ref: z.string().trim().min(1), version: z.string().min(1).nullable() }).strict()),
  minCount: z.number().int().nonnegative().nullable(),
  maxCount: z.number().int().nonnegative().nullable(),
  characterIds: z.array(uuid),
  reason: z.string(),
}).strict().superRefine((value, context) => {
  if ((value.minCount === null) !== (value.maxCount === null) ||
      (value.minCount !== null && value.maxCount !== null && value.minCount > value.maxCount)) {
    context.addIssue({ code: 'custom', message: '需求人数范围无效' })
  }
  if (new Set(value.characterIds).size !== value.characterIds.length) context.addIssue({ code: 'custom', message: '需求角色 ID 重复' })
  if ((value.status === 'existing' || value.status === 'created') && value.minCount !== null && value.characterIds.length < value.minCount) {
    context.addIssue({ code: 'custom', message: '需求尚未达到人数下限' })
  }
})
export const requirementsSchema = z.object({ formatVersion: z.literal(1), requirements: z.array(requirementSchema) }).strict().superRefine((value, context) => {
  if (new Set(value.requirements.map(item => item.id)).size !== value.requirements.length) context.addIssue({ code: 'custom', message: '需求 ID 重复' })
})
export type Requirements = z.infer<typeof requirementsSchema>

function frontMatter(text: string): { data: unknown; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new Error('缺少有效的 YAML front matter')
  const document = parseDocument(match[1]!, { uniqueKeys: true })
  if (document.errors.length) throw new Error('YAML 元数据无效', { cause: document.errors[0] })
  return { data: document.toJS({ maxAliasCount: 0 }), body: text.slice(match[0].length).replace(/^\r?\n/, '') }
}

/** 解析角色文件；拒绝未知版本、重复字段和不合法元数据。 */
export function parseCharacterDocument(text: string): CharacterDocument {
  const parsed = frontMatter(text)
  return { metadata: characterMetadataSchema.parse(parsed.data), body: parsed.body }
}

/** 将已校验角色资料序列化为 UTF-8 Markdown 内容。 */
export function formatCharacterDocument(document: CharacterDocument): string {
  const metadata = characterMetadataSchema.parse(document.metadata)
  return `---\n${stringify(metadata)}---\n\n${document.body.replace(/\s*$/, '')}\n`
}

/** 解析需求清单，正文供人阅读而非机器状态来源。 */
export function parseRequirementsDocument(text: string): { data: Requirements; body: string } {
  const parsed = frontMatter(text)
  return { data: requirementsSchema.parse(parsed.data), body: parsed.body }
}

/** 序列化已校验需求清单。 */
export function formatRequirementsDocument(data: Requirements, body: string): string {
  return `---\n${stringify(requirementsSchema.parse(data))}---\n\n${body.replace(/\s*$/, '')}\n`
}
