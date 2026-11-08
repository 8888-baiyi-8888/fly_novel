import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { writableRoots } from '@fly-novel/sandbox'
import { isPathUnder } from '@fly-novel/fs-sandbox'

/** 可信应用显式指定的读取视图、草稿目录和已确认资料目录。 */
export interface WorldInitializationWorkspace {
  viewRoot: string
  draftRoot: string
  confirmedRoot: string
}

/** 校验并规范化已有目录，不创建或修改任何用户数据。 */
export async function validateWorldInitializationWorkspace(input: WorldInitializationWorkspace): Promise<Readonly<WorldInitializationWorkspace>> {
  if (!input || typeof input !== 'object') throw new Error('必须显式提供世界初始化工作区')
  const directory = async (path: unknown, name: string): Promise<string> => {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error(`${name}必须是绝对目录路径`)
    const physical = await realpath(path)
    if (!(await stat(physical)).isDirectory()) throw new Error(`${name}必须是现有目录`)
    if (physical !== resolve(path)) throw new Error(`${name}必须使用真实路径`)
    return physical
  }
  const [viewRoot, draftRoot, confirmedRoot] = await Promise.all([
    directory(input.viewRoot, '读取视图'), directory(input.draftRoot, '草稿根'), directory(input.confirmedRoot, '已确认资料根'),
  ])
  if (!await isPathUnder(draftRoot, viewRoot) || !await isPathUnder(confirmedRoot, viewRoot)) throw new Error('草稿根和已确认资料根必须位于读取视图内')
  for (const root of writableRoots({ mode: 'workspace-write', workspaceRoot: draftRoot })) {
    if (await isPathUnder(confirmedRoot, root) || await isPathUnder(root, confirmedRoot)) throw new Error('已确认资料根与可写目录重叠')
  }
  return Object.freeze({ viewRoot, draftRoot, confirmedRoot })
}
