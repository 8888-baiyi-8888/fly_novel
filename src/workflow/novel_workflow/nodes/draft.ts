import type { ClarifyUserAnswer, CreativeDraftAgent } from "../../../novel-flow/draft/creative-draft-agent";
import type { NovelArtifacts } from "../artifacts";
import type { NovelWorkflowState } from "../state";

/** 根据整理后的原始输入生成创意草案。 */
export async function runDraft(
  state: Pick<NovelWorkflowState, "normalizedInput">,
  draftAgent: CreativeDraftAgent,
  persist: boolean,
  novelId: string,
  artifacts: NovelArtifacts,
  askUser?: ClarifyUserAnswer,
): Promise<Partial<NovelWorkflowState>> {
  const normalizedInput = state.normalizedInput?.normalizedInput;
  if (normalizedInput === undefined) {
    throw new Error("缺少 normalized_input 节点产物，无法生成创意草案");
  }
  const draft = askUser === undefined
    ? await draftAgent.createDraft(normalizedInput)
    : await draftAgent.createDraftWithClarification(normalizedInput, askUser);
  if (persist) artifacts.saveDraft(draft, novelId);
  return { draft };
}
