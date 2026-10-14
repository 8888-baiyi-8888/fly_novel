import { StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import type { BookConfig } from "../../novel-flow/book-config";
import type { BookRules, StoryBible } from "../../novel-flow/architect/types";
import type { StoryArchitecture } from "../../novel-flow/architecture/types";
import type { LongTermControls } from "../../novel-flow/controls/types";
import type { CreativeDraft } from "../../novel-flow/draft/types";
import type { State0 } from "../../novel-flow/state0/types";
import type { BuildWorkspaceResult } from "../../novel-flow/workspace/types";

/** 小说工作流唯一状态定义；领域产物由各生产节点校验，图在此定义字段及其类型。 */
export const NovelWorkflowSchema = new StateSchema({
  rawInput: z.object({
    userInput: z.string(),
    novel_id: z.string(),
    autoNovelId: z.boolean().optional(),
  }),
  normalizedInput: z.object({
    normalizedInput: z.string().optional(),
    rawInputFromCache: z.boolean().optional(),
  }).optional(),
  draft: z.custom<CreativeDraft>().optional(),
  bookConfig: z.custom<BookConfig>().optional(),
  storyBible: z.custom<StoryBible>().optional(),
  bookRules: z.custom<BookRules>().optional(),
  controls: z.custom<LongTermControls>().optional(),
  architecture: z.custom<StoryArchitecture>().optional(),
  state0: z.custom<State0>().optional(),
  workspace: z.custom<BuildWorkspaceResult>().optional(),
  ready: z.object({
    novelId: z.string(),
    status: z.enum(["ready", "warn"]),
    checkedAt: z.string(),
  }).optional(),
});

export type NovelWorkflowState = typeof NovelWorkflowSchema.State;
