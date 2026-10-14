import { STEP_ORDER, type ChapterState, type ChapterStatus, type Step } from "../../../novel/types";
import type { WorkflowEvent, WorkflowStore } from "../../types";
import type { ChapterGraphState } from "../state";

export interface TransitionNodeOptions {
  readonly store: WorkflowStore;
  readonly maxRetries: number;
  readonly notify?: (event: WorkflowEvent) => void;
}

function statusAfterStep(step: Step): ChapterStatus {
  switch (step) {
    case "direct": return "planned";
    case "simulate": return "simulated";
    case "merge": return "woven";
    case "write": return "drafted";
    case "audit": return "audited";
    case "censor": return "censored";
    case "settle": return "settled";
  }
}

function nextStep(step: Step): Step {
  return STEP_ORDER[Math.min(STEP_ORDER.indexOf(step) + 1, STEP_ORDER.length - 1)];
}

/** 推进章节状态、应用重试预算，并保存每次图状态转移。 */
export function createTransitionNode(options: TransitionNodeOptions) {
  const { store, maxRetries, notify } = options;

  return async (state: ChapterGraphState) => {
    const outcome = state.outcome;
    if (outcome === undefined) return { resultKind: "invalid" as const, reason: "章节节点没有返回 outcome" };

    if (outcome.kind === "continue") {
      const completed = state.step;
      const status = statusAfterStep(completed);
      const step = nextStep(completed);
      const nextState: ChapterState = { novelId: state.novelId, chapter: state.chapter, step, status, retries: state.retries };
      await store.save({ novelId: state.novelId, chapter: state.chapter, state: nextState, artifacts: state.artifacts });
      notify?.({ type: "step-completed", novelId: state.novelId, chapter: state.chapter, step: completed, state: nextState });
      if (completed === "settle") notify?.({ type: "completed", novelId: state.novelId, chapter: state.chapter, state: nextState });
      return completed === "settle"
        ? { step, status, resultKind: "completed" as const }
        : { step, status, outcome: undefined };
    }

    if (outcome.kind === "retry") {
      if (!STEP_ORDER.includes(outcome.step)) return { resultKind: "invalid" as const, reason: `非法回退目标: ${outcome.step}` };
      if (state.retries < maxRetries) {
        const retries = state.retries + 1;
        const nextState: ChapterState = { novelId: state.novelId, chapter: state.chapter, step: outcome.step, status: state.status, retries };
        await store.save({ novelId: state.novelId, chapter: state.chapter, state: nextState, artifacts: state.artifacts });
        notify?.({ type: "retrying", novelId: state.novelId, chapter: state.chapter, from: state.step, to: outcome.step, attempt: retries });
        return { step: outcome.step, retries, outcome: undefined };
      }
      const nextState: ChapterState = { novelId: state.novelId, chapter: state.chapter, step: outcome.step, status: state.status, retries: state.retries };
      await store.save({ novelId: state.novelId, chapter: state.chapter, state: nextState, artifacts: state.artifacts });
      notify?.({ type: "suspended", novelId: state.novelId, chapter: state.chapter, step: state.step, reason: outcome.reason, state: nextState });
      return { step: outcome.step, resultKind: "suspended" as const, reason: outcome.reason };
    }

    const kind = outcome.kind === "suspend" ? "suspended" as const : "failed" as const;
    const currentState: ChapterState = { novelId: state.novelId, chapter: state.chapter, step: state.step, status: state.status, retries: state.retries };
    await store.save({ novelId: state.novelId, chapter: state.chapter, state: currentState, artifacts: state.artifacts });
    notify?.({ type: outcome.kind === "suspend" ? "suspended" : "failed", novelId: state.novelId, chapter: state.chapter, step: state.step, reason: outcome.reason, state: currentState });
    return { resultKind: kind, reason: outcome.reason };
  };
}
