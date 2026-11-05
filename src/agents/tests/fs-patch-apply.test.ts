/** 测试样例改编自 DeepSeek Harness fs-patch，上游许可证见 ../plugins/fs/fs-patch/LICENSE。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { applyHunks, parsePatch } from '../plugins/fs/fs-patch/index.js'

function update(...body: string[]) {
  const [operation] = parsePatch(['*** Begin Patch', '*** Update File: a', ...body, '*** End Patch'].join('\n'))
  if (operation?.kind !== 'update') throw new Error('预期更新操作')
  return operation.hunks
}

test('多个片段依次匹配原文并生成完整结果', () => {
  const hunks = update(' foo', '-bar', '+BAR', '@@', ' baz', '-qux', '+QUX')
  const original = structuredClone(hunks)
  assert.deepEqual(applyHunks('foo\nbar\nbaz\nqux\n', hunks), { ok: true, after: 'foo\nBAR\nbaz\nQUX\n' })
  assert.deepEqual(hunks, original)
})

test('匹配优先精确结果，并支持空白和 Unicode 标点差异', () => {
  assert.deepEqual(applyHunks('x \nx\n', update('-x', '+X')), { ok: true, after: 'x \nX\n' })
  assert.deepEqual(applyHunks('  x  \n', update('-x', '+X')), { ok: true, after: 'X\n' })
  assert.deepEqual(applyHunks('a–b\n', update('-a-b', '+done')), { ok: true, after: 'done\n' })
})

test('锚点和文件末尾限定匹配位置', () => {
  assert.deepEqual(applyHunks('fn a\nx\nfn b\nx\n', update('@@ fn b', '-x', '+X')), { ok: true, after: 'fn a\nx\nfn b\nX\n' })
  assert.deepEqual(applyHunks('x\nx \n', update('-x', '+X', '*** End of File')), { ok: true, after: 'x\nX\n' })
  assert.deepEqual(applyHunks('x\ny\n', update('-x', '+X', '*** End of File')), {
    ok: false, failure: { hunkLineNumber: 3, stage: 'oldLines', searchStart: 0, pattern: ['x'] },
  })
})

test('插入、删除和缺少末尾换行的文本遵循 LF 输出规则', () => {
  assert.deepEqual(applyHunks('', update('+hello')), { ok: true, after: 'hello\n' })
  assert.deepEqual(applyHunks('hello', update('+world')), { ok: true, after: 'hello\nworld\n' })
  assert.deepEqual(applyHunks('a\n', update('-a')), { ok: true, after: '' })
  assert.deepEqual(applyHunks('a\r\nb\r\n', update('-a', '+A')), { ok: true, after: 'A\nb\r\n' })
})

test('不匹配返回结构化失败且不暴露部分修改', () => {
  const hunks = update('-a', '+A', '@@ missing', '-b', '+B')
  const original = structuredClone(hunks)
  assert.deepEqual(applyHunks('a\nb\n', hunks), {
    ok: false, failure: { hunkLineNumber: 5, stage: 'context', searchStart: 1, pattern: ['missing'] },
  })
  assert.deepEqual(hunks, original)
  assert.deepEqual(applyHunks('fn\na\n', update('@@ fn', '-missing', '+b')), {
    ok: false, failure: { hunkLineNumber: 3, stage: 'oldLines', searchStart: 1, pattern: ['missing'] },
  })
})
