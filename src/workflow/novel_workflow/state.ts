import { StateSchema } from "@langchain/langgraph";
import { z } from "zod";

/** 小说工作流唯一状态定义；运行时校验与 TypeScript 类型均由此 schema 派生。 */
export const NovelWorkflowSchema = new StateSchema({
  rawInput: z.object({
    userInput: z.string(),
    novel_id: z.string(),
  }),
  normalizedInput: z.object({
    normalizedInput: z.string().optional(),
    rawInputFromCache: z.boolean().optional(),
  }).optional(),
});

export type NovelWorkflowState = typeof NovelWorkflowSchema.State;
