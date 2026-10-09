import type { ClarifyUserAnswer, CreativeDraftAgent } from "../../../novel-flow/draft/creative-draft-agent";
import { buildBookConfig } from "../../../novel-flow/book-config";
import type { NovelArtifacts } from "../artifacts";
import type { NovelWorkflowState } from "../state";

/** 读取或生成创意草案，并从草案固化书籍配置。 */
export async function runDraft(
  state: Pick<NovelWorkflowState, "normalizedInput">,
  draftAgent: CreativeDraftAgent,
  persist: boolean,
  novelId: string,
  artifacts: NovelArtifacts,
  askUser?: ClarifyUserAnswer,
): Promise<Partial<NovelWorkflowState>> {
  const existing = artifacts.readLatestDraft(novelId);
  let draft = existing;
  if (draft === null) {
    const normalizedInput = state.normalizedInput?.normalizedInput;
    if (normalizedInput === undefined) {
      throw new Error("缺少 normalized_input 节点产物，无法生成创意草案");
    }
    draft = askUser === undefined
      ? await draftAgent.createDraft(normalizedInput)
      : await draftAgent.createDraftWithClarification(normalizedInput, askUser);
    if (persist) artifacts.saveDraft(draft, novelId);
  } else {
    console.log(`\n已存在 draft 节点产物，跳过草案生成（novelId：${novelId}）\n`);
  }

  const existingConfig = existing === null ? null : artifacts.readLatestBookConfig(novelId);
  const bookConfig = existingConfig ?? buildBookConfig(draft);
  if (persist && existingConfig === null) artifacts.saveBookConfig(bookConfig, novelId);
  return { draft, bookConfig };
}
