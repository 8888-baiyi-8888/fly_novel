import { relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/system-prompt'
import type { WorldInitializationWorkspace } from './world-initialization-workspace.js'

type WorkspacePromptConfig = WorldInitializationWorkspace & { readonly mode: 'draft-write' | 'read-only'; readonly catalog?: {
  readonly mainOwner: string; readonly delegates: readonly { readonly owner: string; readonly tool: string }[]
} }

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
  if (config.catalog && config.mode === 'draft-write') {
    const catalog = config.catalog
    const delegates = JSON.stringify(catalog.delegates)
    ctx.effect(() => ctx.systemPrompt.section({ name: 'world-initialization:catalog-alignment', order: 11, interpolate: false,
      text: `资料目录检查与更新：
你的目录负责人身份为 ${JSON.stringify(catalog.mainOwner)}。已装配的其他负责人和专用委派工具映射（owner、tool）为 ${delegates}；未列出的负责人没有已装配的委派工具，不要代其修改，向用户报告未配置。
用户要求检查或需要核对资料时，按顺序从 offset 0 调用 catalog_check_page，翻页携带相同 version；只有全部有效页完成才报告已登记范围检查完成。取消、损坏或冲突时说明已检查和未完成范围；检查不发现未登记文件。
对 stale 记录先用 catalog_read 复查负责人、revision 和状态。属于自己的记录，使用 catalog_read_source 完整读取，依据内容调用 catalog_update；其他记录只交给映射中的对应工具，提供相对路径、原 revision 和更新简介任务，不传授权目录或 Session 配置。missing、unreadable、changing、forbidden 或负责人不可用时保留记录并说明原因。
负责人返回后重新调用 catalog_read，核对负责人、更新后的 revision 和 current 状态；不能把子 Agent 的回复或工具成功当作已对齐的证明。目录更新不代表用户确认。`,
    }))
  }
}, { inject: ['systemPrompt'] })

export const worldInitializationWorkspacePromptPluginDefinition = {
  id: 'world-initialization-workspace-prompt', version: '1.0.0', description: '注册当前工作区和文件权限说明', plugin: worldInitializationWorkspacePromptPlugin,
}
