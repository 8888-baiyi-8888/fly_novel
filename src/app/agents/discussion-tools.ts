import { defineTool } from '@fly-novel/tools'
import { parseDiscussionTarget, type DiscussionService, type DiscussionTarget } from '../../world-init/discussion/service.js'

/** 绑定可信讨论和 Agent 身份；工具不能选择世界或文件路径。 */
export async function createDiscussionTools(service: DiscussionService, discussionId: string, agentId: string, additionalTargets: readonly DiscussionTarget[] = []) {
  const discussion = await service.readDiscussion(discussionId)
  const targets = [discussion.target, ...additionalTargets].map(parseDiscussionTarget)
  if (new Set(targets.map(target => JSON.stringify(target))).size !== targets.length) throw new Error('讨论目标重复')
  for (const target of targets) await service.readRelated(discussionId, target)
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  const authorize = (id: string | undefined) => { if (id !== agentId) throw new Error('讨论工具身份不匹配') }
  const selected = (index: number | undefined) => {
    const n = index ?? 0
    if (!Number.isSafeInteger(n) || n < 0 || n >= targets.length) throw new Error('讨论目标不在授权范围内')
    return targets[n]!
  }
  const active = async (target: DiscussionTarget) => (await service.listCandidates(discussionId)).find(item =>
    item.value.status === 'active' && JSON.stringify(item.value.target) === JSON.stringify(target))
  return [
    defineTool({ name: 'discussion_read', description: '读取授权目标的当前资料及本讨论候选；目标索引由工具结果提供，候选不代表已确认。', parameters: { targetIndex: { type: 'integer', description: '授权目标序号，默认 0。' } }, output,
      async execute({ targetIndex }, exec) {
        authorize(exec.agent?.id)
        const target = selected(targetIndex); const current = await service.readRelated(discussionId, target); const found = await active(target)
        return JSON.stringify({ targets, current, candidate: found ? await service.readCandidate(found.value.id) : null })
      } }),
    defineTool({ name: 'discussion_prepare', description: '为授权的已有目标保存完整待审修改；不支持新增或删除目标，更新候选时必须提供读取到的候选版本。', reportOnAbort: true,
      parameters: { content: { type: 'string', required: true, description: '符合所属模块格式的完整候选正文。' },
        summary: { type: 'string', required: true, description: '本次修改说明。' }, version: { type: 'string', description: '更新已有候选时提供其版本。' },
        targetIndex: { type: 'integer', description: '授权目标序号，默认 0。' } }, output,
      async execute({ content, summary, version, targetIndex }, exec) {
        authorize(exec.agent?.id); exec.signal.throwIfAborted()
        const target = selected(targetIndex); const found = await active(target)
        if (found) {
          if (!version) throw new Error('更新候选需要读取所得版本')
          return JSON.stringify(await service.updateCandidate(discussionId, found.value.id, version, content, summary))
        }
        if (version) throw new Error('候选不存在，请重新读取')
        return JSON.stringify(await service.createCandidate(discussionId, target, content, summary))
      } }),
  ] as const
}
