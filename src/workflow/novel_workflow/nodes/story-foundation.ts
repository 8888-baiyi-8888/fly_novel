import { buildCreativeBrief, type ArchitectAgent } from "../../../novel-flow/architect";
import { saveBookRulesDoc, saveStoryBible } from "../artifacts";
import type { NovelWorkflowState } from "../state";

/** 生成故事圣经与书籍规则。 */
export async function runStoryFoundation(
  state: Pick<NovelWorkflowState, "draft" | "bookConfig">,
  architectAgent: ArchitectAgent,
  persist = true,
): Promise<Partial<NovelWorkflowState>> {
  if (state.draft === undefined || state.bookConfig === undefined) {
    throw new Error("缺少 draft 或 book_config 节点产物，无法生成故事基础设定");
  }
  const brief = buildCreativeBrief(state.draft);
  const { storyBible, bookRules } = await architectAgent.createStoryFoundation(
    brief,
    state.draft,
    state.bookConfig,
  );
  if (persist) {
    saveStoryBible(storyBible);
    saveBookRulesDoc(bookRules);
  }
  return { storyBible, bookRules };
}
