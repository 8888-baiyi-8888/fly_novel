import type { ReviewService, ReviewDocument } from '../world-init/impact/review.js'

/** 可由界面展示的完整变更；相同前后缀不重复列入变化。 */
export function reviewDifference(current: string, candidate: string) {
  const before = current.split('\n'); const after = candidate.split('\n')
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  return { startLine: prefix + 1, removed: before.slice(prefix, before.length - suffix), added: after.slice(prefix, after.length - suffix) }
}

/** 从可信审阅记录构造展示数据；完整正文和所有建议均保留。 */
export function presentWorldReview(review: ReviewDocument, version: string) {
  return { ...review, version, changes: review.reports.map(({ report }) => ({ reportId: report.id, candidateId: report.candidateId,
    difference: reviewDifference(report.currentContent, report.candidateContent) })) }
}

/** 读取用户将审阅的版本；只有可信应用可以持有服务并处理确认动作。 */
export async function readWorldReview(service: ReviewService, discussionId: string, reviewId: string) {
  const { value, version } = await service.read(discussionId, reviewId)
  return presentWorldReview(value, version)
}
