import { defineTool } from '@fly-novel/tools'
import type { DiscussionService } from '../../world-init/discussion/service.js'

/** 绑定可信讨论和 Agent 身份；工具不能选择世界或文件路径。 */
export async function createDiscussionTools(service: DiscussionService, discussionId: string, agentId: string) {
  const discussion = await service.readDiscussion(discussionId)
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  const authorize = (id: string | undefined) => { if (id !== agentId) throw new Error('讨论工具身份不匹配') }
  const active = async () => (await service.listCandidates(discussionId)).find(item =>
    item.value.status === 'active' && JSON.stringify(item.value.target) === JSON.stringify(discussion.target))
  return [
    defineTool({ name: 'discussion_read', description: '读取选定目标的当前资料及本讨论候选；候选不代表已确认。', parameters: {}, output,
      async execute(_args, exec) {
        authorize(exec.agent?.id)
        const current = await service.readCurrent(discussionId); const found = await active()
        return JSON.stringify({ current, candidate: found ? await service.readCandidate(found.value.id) : null })
      } }),
    defineTool({ name: 'discussion_prepare', description: '为已选目标保存完整待审修改；更新时必须提供读取到的候选版本。', reportOnAbort: true,
      parameters: { content: { type: 'string', required: true, description: '符合所属模块格式的完整候选正文。' },
        summary: { type: 'string', required: true, description: '本次修改说明。' }, version: { type: 'string', description: '更新已有候选时提供其版本。' } }, output,
      async execute({ content, summary, version }, exec) {
        authorize(exec.agent?.id); exec.signal.throwIfAborted()
        const found = await active()
        if (found) {
          if (!version) throw new Error('更新候选需要读取所得版本')
          return JSON.stringify(await service.updateCandidate(discussionId, found.value.id, version, content, summary))
        }
        if (version) throw new Error('候选不存在，请重新读取')
        return JSON.stringify(await service.createCandidate(discussionId, discussion.target, content, summary))
      } }),
  ] as const
}
