import { relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/system-prompt'
import type { WorldInitializationWorkspace } from './world-initialization-workspace.js'

type WorkspacePromptConfig = WorldInitializationWorkspace & { readonly mode: 'draft-write' | 'read-only' }

/** 将可信工作区的路径及当前 Agent 权限注册到所属提示词作用域。 */
export const worldInitializationWorkspacePromptPlugin = Object.assign(function worldInitializationWorkspacePromptPlugin(ctx: Context, config: WorkspacePromptConfig): void {
  const relativePath = (path: string): string => relative(config.viewRoot, path).split(sep).join('/') || '.'
  const view = JSON.stringify(config.viewRoot)
  const draft = JSON.stringify(relativePath(config.draftRoot))
  const confirmed = JSON.stringify(relativePath(config.confirmedRoot))
  const permission = config.mode === 'draft-write'
    ? `可创建、修改和删除的草稿目录：${draft}。创建或修改文件时，请使用该目录下的路径，例如 ${JSON.stringify(`${relativePath(config.draftRoot)}/文件名.md`)}。\n已确认资料目录：${confirmed}，只能读取和搜索，不得修改。`
    : `当前 Agent 只能读取和搜索工作区文件，不能创建、修改或删除文件。已确认资料目录为 ${confirmed}；草稿目录为 ${draft}，同样只能读取。`
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'world-initialization:workspace', order: 10, interpolate: false,
    text: `文件工作区：\n读取和搜索范围：${view}。\n相对路径以该工作区根目录为基准。\n${permission}`,
  }))
}, { inject: ['systemPrompt'] })

export const worldInitializationWorkspacePromptPluginDefinition = {
  id: 'world-initialization-workspace-prompt', version: '1.0.0', description: '注册当前工作区和文件权限说明', plugin: worldInitializationWorkspacePromptPlugin,
}
