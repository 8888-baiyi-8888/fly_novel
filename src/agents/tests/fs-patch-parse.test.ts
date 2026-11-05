import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePatch, PatchParseError } from '../plugins/fs/fs-patch/index.js'

const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')

test('补丁解析保留文件操作顺序、重复路径和移动目标', () => {
  const operations = parsePatch(patch(
    '*** Add File: a', '+hello',
    '*** Update File: a', '*** Move to: b', '@@ hello', '-hello', '+hi',
    '*** Delete File: b', '*** Add File: a',
  ))
  assert.deepEqual(operations, [
    { kind: 'add', path: 'a', lineNumber: 2, content: 'hello\n' },
    { kind: 'update', path: 'a', lineNumber: 4, moveTo: 'b', hunks: [
      { lineNumber: 6, context: 'hello', oldLines: ['hello'], newLines: ['hi'], isEndOfFile: false },
    ] },
    { kind: 'delete', path: 'b', lineNumber: 9 },
    { kind: 'add', path: 'a', lineNumber: 10, content: '' },
  ])
})

test('补丁解析支持多个片段、文件末尾标记和 CRLF', () => {
  const input = patch('*** Update File: 文件', '-old', '+new', '@@ next', ' same', '+tail', '*** End of File')
  const [operation] = parsePatch(input.replaceAll('\n', '\r\n'))
  assert.deepEqual(operation, { kind: 'update', path: '文件', lineNumber: 2, hunks: [
    { lineNumber: 3, oldLines: ['old'], newLines: ['new'], isEndOfFile: false },
    { lineNumber: 5, context: 'next', oldLines: ['same'], newLines: ['same', 'tail'], isEndOfFile: true },
  ] })
})

test('补丁解析保留路径原文和内容空白，不解释包装中的文本', () => {
  const input = `\n<<EOF\n${patch('*** Add File: ../文件', '+ value  ')}\nEOF\n`
  assert.deepEqual(parsePatch(input), [{ kind: 'add', path: '../文件', lineNumber: 4, content: ' value  \n' }])
  assert.deepEqual(parsePatch(patch()), [])
})

test('补丁解析拒绝无效语法并报告原始输入行号', () => {
  assert.throws(() => parsePatch('\n*** Begin Patch\n*** Update File: a\n*** End Patch'), (error: unknown) => {
    assert.ok(error instanceof PatchParseError)
    assert.equal(error.lineNumber, 3)
    assert.match(error.reason, /requires at least one hunk/)
    return true
  })
  assert.throws(() => parsePatch(patch('*** Add File: a', 'invalid')), PatchParseError)
  assert.throws(() => parsePatch('--- a\n+++ b'), PatchParseError)
})
