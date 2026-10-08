import { buildWorkspace } from "../../../novel-flow/workspace";
import type { NovelWorkflowState } from "../state";

/** 将前序节点产物写入书籍工作空间。 */
export function runWorkspace(
  state: Pick<NovelWorkflowState, "draft" | "bookConfig" | "storyBible" | "bookRules" | "controls" | "architecture" | "state0">,
  persist = true,
  force = false,
): Partial<NovelWorkflowState> {
  const { draft, bookConfig, storyBible, bookRules, controls, architecture, state0 } = state;
  if (
    draft === undefined || bookConfig === undefined || storyBible === undefined ||
    bookRules === undefined || controls === undefined || architecture === undefined || state0 === undefined
  ) {
    throw new Error("缺少建书流程产物，无法创建书籍工作空间");
  }
  const workspace = buildWorkspace(
    { draft, bookConfig, storyBible, bookRules, controls, architecture, state0 },
    { dryRun: !persist, force },
  );
  return { workspace };
}
