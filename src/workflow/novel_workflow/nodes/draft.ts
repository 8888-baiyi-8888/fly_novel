import type { ClarifyUserAnswer, CreativeDraftAgent } from "../../../novel-flow/draft/creative-draft-agent";
import type { NovelArtifacts } from "../artifacts";
import type { NovelWorkflowState } from "../state";

/** 优先复用指定小说的最新草案；没有草案时根据整理后的输入生成并按需保存。 */
export async function runDraft(
  state: Pick<NovelWorkflowState, "normalizedInput">,
  draftAgent: CreativeDraftAgent,
  persist: boolean,
  novelId: string,
  artifacts: NovelArtifacts,
  askUser?: ClarifyUserAnswer,
): Promise<Partial<NovelWorkflowState>> {
  const existing = artifacts.readLatestDraft(novelId);
  if (existing !== null) {
    console.log(`\n已存在 draft 节点产物，跳过草案生成（novelId：${novelId}）\n`);
    return { draft: existing };
  }

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
