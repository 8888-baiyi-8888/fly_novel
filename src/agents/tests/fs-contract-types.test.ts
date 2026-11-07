import assert from 'node:assert/strict'
import test from 'node:test'
import { LlmBaseError } from '@fly-novel/llm'
import { FS_ERROR_CODES, FsError, FsTargetKey, FsVersion } from '../plugins/fs/fs/index.js'
import type { FileSystem, FsMoveOutcome, FsTarget, FsTargetKey as TargetKey, FsVersion as Version, FsWriteIntent } from '../plugins/fs/fs/index.js'
import type { PatchHunk } from '../plugins/fs/fs-patch/index.js'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T
type PatchParameters = Parameters<FileSystem['patchText']>
type WriteParameters = Parameters<FileSystem['writeText']>
type MoveParameters = Parameters<FileSystem['moveFile']>
type ContractChecks = [
  Expect<Equal<PatchParameters, [target: FsTarget, hunks: readonly PatchHunk[], expected?: { version: Version }, signal?: AbortSignal]>>,
  Expect<Equal<WriteParameters, [target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal]>>,
  Expect<Equal<MoveParameters[2], { hunks?: readonly PatchHunk[]; expectedSource?: { version: Version }; expectedDestination?: FsWriteIntent }>>,
  Expect<Equal<TargetKey extends Version ? true : false, false>>,
  Expect<Equal<Version extends TargetKey ? true : false, false>>,
]
const contractChecks: ContractChecks = [true, true, true, true, true]

test('文件契约公开兼容的补丁和版本类型', () => {
  assert.deepEqual(contractChecks, [true, true, true, true, true])
  assert.equal(FsTargetKey('target'), 'target')
  assert.equal(FsVersion('v1'), 'v1')
})

test('文件错误保留稳定代码、类身份和底层原因', () => {
  const cause = new Error('底层错误')
  const error = new FsError('读取失败', 'FS_NOT_FOUND', { cause })
  assert.ok(error instanceof LlmBaseError)
  assert.equal(error.name, 'FsError')
  assert.equal(error.code, 'FS_NOT_FOUND')
  assert.equal(error.cause, cause)
  assert.ok(FS_ERROR_CODES.includes(error.code))
})

test('移动结果区分源文件删除成功和目标已发布但源文件保留', () => {
  const destination = { operation: 'create' as const, version: FsVersion('v2'), before: null, after: 'text' }
  const outcome: FsMoveOutcome = { sourceBefore: 'text', destination, sourceDeleted: false, sourceFailure: { code: 'FS_PERMISSION_DENIED', message: '删除失败' } }
  assert.equal(outcome.destination.after, 'text')
  assert.equal(outcome.sourceFailure.code, 'FS_PERMISSION_DENIED')
})
