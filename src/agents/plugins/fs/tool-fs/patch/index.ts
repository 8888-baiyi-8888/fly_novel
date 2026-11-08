/** Internal patch executor; tool registration and persisted result metadata are owned by its caller. */
import type { Context } from '@deepseek-ai/cordis'
import { PatchParseError } from '@fly-novel/fs-patch'
import type { ToolRunContext } from '@fly-novel/tools'
import { commitPatch } from './execute.ts'
import { planPatch } from './plan.ts'
import { preflightPatch } from './preflight.ts'
import type { PatchExecutionReport, PatchExecutionRequest } from './types.ts'

export type { PatchExecutionReport, PatchExecutionRequest, PatchFailure, PatchFailureCode, PatchFileChange, PatchOperationOutcome, PatchOperationRecord, PatchRefusal } from './types.ts'

/**
 * Preflight a whole patch before sequential guarded mutations; business failures become records.
 * @param ctx - mounted filesystem and observation-policy events.
 * @param exec - session cwd, observation actor, and cancellation signal.
 * @param request - raw patch.
 * @returns the syntax failure, the preflight refusals, or ordered commit outcomes.
 * @throws unexpected programming defects without starting further operations.
 */
export async function executePatch(
  ctx: Context, exec: ToolRunContext, request: PatchExecutionRequest,
): Promise<PatchExecutionReport> {
  let plan
  try { plan = await planPatch(ctx, exec, request) } catch (error) {
    if (!(error instanceof PatchParseError)) throw error
    return { phase: 'syntax', failure: { code: 'PATCH_SYNTAX', message: error.message } }
  }
  const [first, ...rest] = [
    ...plan.refusals,
    ...await preflightPatch(ctx, exec, plan.operations),
  ].sort((left, right) => left.operation.index - right.operation.index)
  if (first !== undefined) return { phase: 'preflight', refusals: [first, ...rest] }
  return commitPatch(ctx, exec, plan.operations)
}
