import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatCharacterDocument, formatRequirementsDocument, parseCharacterDocument, parseRequirementsDocument } from '../character-format.js'

const id = '2e59b48c-2c7c-4abc-b232-97dc06111001'

test('角色 Markdown 往返保留身份、分类、状态和正文', () => {
  const document = { metadata: { formatVersion: 1 as const, id, name: '林岚', summary: '', contentStatus: 'suggested' as const,
    categories: { faction: [{ id: 'sect-1', name: '青云宗' }] } }, body: '# 林岚\n\n尚未确认。\n' }
  assert.deepEqual(parseCharacterDocument(formatCharacterDocument(document)), document)
})

test('角色资料拒绝未知版本、重复字段和重复分类', () => {
  const document = { metadata: { formatVersion: 1 as const, id, name: '林岚', summary: '', contentStatus: 'suggested' as const,
    categories: { faction: [{ id: 'sect-1', name: '青云宗' }] } }, body: '资料' }
  const valid = formatCharacterDocument(document)
  assert.throws(() => parseCharacterDocument(valid.replace('formatVersion: 1', 'formatVersion: 2')))
  assert.throws(() => parseCharacterDocument(valid.replace('name: 林岚', 'name: 林岚\nname: 另一个')))
  assert.throws(() => formatCharacterDocument({ ...document, metadata: { ...document.metadata,
    categories: { faction: [{ id: 'x', name: '甲' }, { id: 'x', name: '乙' }] } } }))
})

test('需求清单校验人数范围、已满足状态及重复标识', () => {
  const requirement = { id, status: 'needed' as const, description: '调查者', sources: [{ ref: '故事', version: null }],
    minCount: 1, maxCount: 2, characterIds: [], reason: '待创建' }
  const data = { formatVersion: 1 as const, requirements: [requirement] }
  assert.deepEqual(parseRequirementsDocument(formatRequirementsDocument(data, '# 需求')).data, data)
  assert.throws(() => formatRequirementsDocument({ ...data, requirements: [requirement, requirement] }, ''))
  assert.throws(() => formatRequirementsDocument({ ...data, requirements: [{ ...requirement, status: 'created' }] }, ''))
  assert.throws(() => formatRequirementsDocument({ ...data, requirements: [{ ...requirement, minCount: 3 }] }, ''))
})
