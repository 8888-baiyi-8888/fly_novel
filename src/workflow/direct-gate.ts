import type { Dispatch } from '../novel/types'
import type { DispatchGateVerdict } from '../novel/gates/dispatch-gate'
import type { StepNode, StepRunContext } from './types.ts'

/**
 * direct 节点闸门契约（章节级文档 §5.3）：把 Dispatch 校验闸门接到 direct 节点产物上。
 * direct 节点产出 Dispatch 后必须通过闸门；未通过 → 返回 retry 回 direct（reason 附违规摘要），
 * 由引擎的重试预算决定重跑或挂起。节点自带的非 continue 结果（suspend/fail/无产物）原样透传。
 *
 * 用法（B 写 direct 节点时）：
 * ```ts
 * withDispatchGate(directNodeImpl, (output) =>
 *   validateDispatch({ dispatch: output, context: viewForChapter(chapter), ledger }),
 * )
 * ```
 */
export function withDispatchGate(
  node: StepNode<'direct'>,
  judge: (output: Dispatch, ctx: StepRunContext) => DispatchGateVerdict,
): StepNode<'direct'> {
  return {
    step: 'direct',
    run: async (ctx) => {
      const result = await node.run(ctx)
      if (result.outcome.kind !== 'continue' || result.output === undefined) return result
      const verdict = judge(result.output, ctx)
      if (verdict.passed) return result
      const summary = verdict.violations.map((v) => `[${v.rule}] ${v.message}`).join('；')
      return { outcome: { kind: 'retry', step: 'direct', reason: `Dispatch 未通过校验闸门：${summary}` } }
    },
  }
}
