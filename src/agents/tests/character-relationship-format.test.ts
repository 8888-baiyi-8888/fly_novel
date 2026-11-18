import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatCharacterRelationship, parseCharacterRelationship } from '@fly-novel/character'

const a = '2e59b48c-2c7c-4abc-b232-97dc06111001'
const b = 'a903f138-ccaf-4ef4-b89f-04d89c3c1ab2'
const entryId = '414dc34c-619e-4397-b553-bc40fc38f151'
const sample = { formatVersion: 1 as const, worldId: 'world', id: '5ac5fb8d-8827-4b52-bbd6-07e4878c5513',
  participants: [{ kind: 'linked' as const, id: a }, { kind: 'linked' as const, id: b }] as [{ kind: 'linked'; id: string }, { kind: 'linked'; id: string }],
  relations: [{ id: entryId, name: '师徒', direction: 'a-to-b' as const, description: '师父指向徒弟' }], contentStatus: 'suggested' as const }

test('人物关系格式保留方向和 ID，拒绝无效版本、重复键及自身关系', () => {
  assert.deepEqual(parseCharacterRelationship(formatCharacterRelationship(sample)), sample)
  assert.throws(() => parseCharacterRelationship('{"formatVersion":1,"formatVersion":1}'))
  assert.throws(() => parseCharacterRelationship(JSON.stringify({ ...sample, formatVersion: 2 })))
  assert.throws(() => parseCharacterRelationship(JSON.stringify({ ...sample, participants: [sample.participants[0], sample.participants[0]] })))
  assert.throws(() => parseCharacterRelationship(JSON.stringify({ ...sample, relations: [sample.relations[0], sample.relations[0]] })))
})
