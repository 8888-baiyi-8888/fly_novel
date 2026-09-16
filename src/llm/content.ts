import type { ContentBlock, FileAttachmentRef, ImageAttachmentRef } from './types'
import type { Message } from './message'

/** 递归检查内容及嵌套工具结果中是否含文件。 */
export function contentHasFile(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'file'
    || (block.type === 'tool-result' && contentHasFile(block.content)))
}

/** 递归检查内容及嵌套工具结果中是否含图片。 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image'
    || (block.type === 'tool-result' && contentHasImage(block.content)))
}

/**
 * 将文件引用转换为模型可读的路径说明，不修改原消息。
 * @param messages 完整请求历史。
 * @param resolvePath 解析文件当前可读路径；不可访问时返回 undefined。
 * @returns 没有文件时返回原数组，否则仅复制发生变化的消息。
 */
export function projectFilesToText(
  messages: readonly Message[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): readonly Message[] {
  if (!messages.some(message => contentHasFile(message.content))) return messages
  return messages.map(message => {
    const content = replaceFilesWithHandles(message.content, resolvePath)
    return content === message.content ? message : { ...message, content }
  })
}

/** 替换文件块及嵌套工具结果中的文件，保留其余内容。 */
function replaceFilesWithHandles(
  blocks: ContentBlock[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'file') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: fileHandleText(block.attachment, resolvePath(block.attachment)) })
      continue
    }
    if (block.type === 'tool-result') {
      const content = replaceFilesWithHandles(block.content, resolvePath)
      if (content !== block.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...block, content })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? blocks
}

/**
 * 生成文件身份及只读路径说明。
 * @param ref 原始文件引用。
 * @param readonlyPath 文件的可读路径；缺失时说明无法读取。
 * @returns 包含文件名、大小和访问方式的稳定文本。
 */
export function fileHandleText(ref: FileAttachmentRef, readonlyPath: string | undefined): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  const identity = `File ${JSON.stringify(ref.name)} (${ref.bytes} bytes, sha256:${digest})`
  if (readonlyPath === undefined) {
    return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`
  }
  return `[${identity}: verbatim read-only copy saved at ${JSON.stringify(readonlyPath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`
}

/** 为不接受图片的模型生成稳定的附件占位文本。 */
export function textOnlyImageText(ref: ImageAttachmentRef): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  return `[image omitted because this model accepts text only; attachment sha256:${digest}]`
}

/** 替换图片块及嵌套工具结果中的图片，保留其余内容。 */
function replaceImagesForTextModel(blocks: ContentBlock[]): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: textOnlyImageText(block.attachment) })
      continue
    }
    if (block.type === 'tool-result') {
      const content = replaceImagesForTextModel(block.content)
      if (content !== block.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...block, content })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? blocks
}

/**
 * 为纯文本模型替换图片引用，不修改原消息。
 * @param messages 完整请求历史。
 * @returns 没有图片时返回原数组，否则仅复制发生变化的消息。
 */
export function projectImagesForTextModel(messages: readonly Message[]): readonly Message[] {
  if (!messages.some(message => contentHasImage(message.content))) return messages
  return messages.map(message => {
    const content = replaceImagesForTextModel(message.content)
    return content === message.content ? message : { ...message, content }
  })
}
