import { defineTool } from '@fly-novel/tools'
import { parseDiscussionTarget, type DiscussionService, type DiscussionTarget } from '../../world-init/discussion/service.js'
import type { ImpactService } from '../../world-init/impact/service.js'

/**
 * 绑定可信讨论、目标范围和 Agent，提供只读影响线索检查。
 * @param impact 由应用持有的影响检查服务。
 * @param discussion 与检查服务绑定的讨论服务。
 * @param discussionId 可信讨论 ID。
 * @param agentId 获授权的 Agent 身份。
 * @param additionalTargets 可信应用授权的关联目标。
 * @returns 可由调用方注册并随 Agent 释放的工具。
 * @throws 讨论不存在、身份无效或目标无法解析时拒绝。
 */
export async function createImpactTools(impact: ImpactService, discussion: DiscussionService, discussionId: string, agentId: string, additionalTargets: readonly DiscussionTarget[] = []) {
  if (!agentId.trim() || !impact.isBoundTo(discussion)) throw new Error('影响检查工具身份或讨论绑定无效')
  const record = await discussion.readDiscussion(discussionId)
  const allowed = new Set([record.target, ...additionalTargets].map(value => JSON.stringify(parseDiscussionTarget(value))))
  const authorize = (id: string | undefined) => { if (id !== agentId) throw new Error('影响检查工具身份不匹配') }
  const checkTarget = (target: unknown) => { if (!allowed.has(JSON.stringify(parseDiscussionTarget(target)))) throw new Error('检查目标不在授权范围内') }
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
  return [
    defineTool({ name: 'impact_check', description: '对本讨论授权的候选执行只读关联检查，报告实际范围和未覆盖内容；不自动判断语义冲突。', reportOnAbort: true,
      parameters: { candidateId: { type: 'string', required: true, description: '已读取的本讨论候选 ID。' } }, output,
      async execute({ candidateId }, exec) {
        authorize(exec.agent?.id); exec.signal.throwIfAborted()
        const candidate = await discussion.readCandidate(candidateId)
        if (candidate.value.discussionId !== discussionId) throw new Error('候选不属于当前讨论')
        checkTarget(candidate.value.target)
        return JSON.stringify(await impact.check(discussionId, candidateId, exec.signal))
      } }),
    defineTool({ name: 'impact_read', description: '读取本讨论已保存的影响检查报告。',
      parameters: { reportId: { type: 'string', required: true, description: '检查报告 ID。' } }, output,
      async execute({ reportId }, exec) {
        authorize(exec.agent?.id); exec.signal.throwIfAborted()
        const result = await impact.read(discussionId, reportId)
        checkTarget(result.report.target)
        return JSON.stringify(result)
      } }),
  ] as const
}
