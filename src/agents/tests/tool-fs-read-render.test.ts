import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWindow, formatReadOutput } from '@fly-novel/tool-fs'

// 按 DeepSeek Harness read-render 测试验证行为；MIT 许可见文件工具包 LICENSE。
test('跨块读取保留行号并限制选中行、行长度和输出字节', async () => {
  async function* chunks() { yield 'first\r'; yield '\nlong text\nthird\n' }
  const result = await buildWindow(chunks(), { offset: 2, limit: 2, maxLineLength: 4, maxBytes: 100 }, 'file')
  assert.deepEqual(result, { lines: [{ number: 2, text: 'long... (line truncated to 4 chars)' }, { number: 3, text: 'thir... (line truncated to 4 chars)' }], totalLines: 3, truncatedByBytes: false })
  assert.match(formatReadOutput('file', { offset: 2, lines: result.lines, totalLines: result.totalLines }), /2: long/)
  const capped = await buildWindow(['a\nb\nc'], { offset: 1, limit: 3, maxLineLength: 100, maxBytes: 2 }, 'file')
  assert.deepEqual(capped, { lines: [{ number: 1, text: 'a' }], totalLines: 3, truncatedByBytes: true })
})

test('超出文件末尾的偏移以文件错误拒绝', async () => {
  await assert.rejects(buildWindow(['one'], { offset: 3, limit: 1, maxLineLength: 50, maxBytes: 50 }, 'file'), { code: 'FS_NOT_FOUND' })
})
