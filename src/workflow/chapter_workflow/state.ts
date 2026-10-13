import { StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import type { BookId, ChapterStatus, Step } from "../../novel/types";
import type { NodeOutput } from "../types";

const OutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("continue") }),
  z.object({ kind: z.literal("retry"), step: z.custom<Step>(), reason: z.string() }),
  z.object({ kind: z.literal("suspend"), reason: z.string() }),
  z.object({ kind: z.literal("fail"), reason: z.string() }),
]);

/** 章节 LangGraph 的共享状态；业务产物沿用 WorkflowStore 的 artifacts 结构。 */
export const ChapterGraphStateSchema = new StateSchema({
  bookId: z.custom<BookId>(),
  chapter: z.number(),
  step: z.custom<Step>(),
  status: z.custom<ChapterStatus>(),
  retries: z.number(),
  artifacts: z.record(z.string(), z.custom<NodeOutput>()),
  outcome: OutcomeSchema.optional(),
  resultKind: z.enum(["completed", "already-complete", "suspended", "failed", "invalid"]).optional(),
  reason: z.string().optional(),
});

export type ChapterGraphState = typeof ChapterGraphStateSchema.State;
