import type { ClarifyUserAnswer, CreativeDraftAgent } from "../../../novel-flow/draft/creative-draft-agent";
import { buildBookConfig } from "../../../novel-flow/book-config";
import type { NovelArtifacts } from "../artifacts";
import type { NovelWorkflowState } from "../state";

/** 读取或生成创意草案，并从草案固化书籍配置。 */
export async function runDraft(
  state: Pick<NovelWorkflowState, "normalizedInput"> & Partial<Pick<NovelWorkflowState, "rawInput">>,
  draftAgent: CreativeDraftAgent,
  persist: boolean,
  novelId: string,
  artifacts: NovelArtifacts,
  askUser?: ClarifyUserAnswer,
): Promise<Partial<NovelWorkflowState>> {
  const autoNovelId = state.rawInput?.autoNovelId === true;
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
  } else {
    console.log(`\n已存在 draft 节点产物，跳过草案生成（novelId：${novelId}）\n`);
  }

  const resolvedNovelId = autoNovelId ? artifacts.generateNovelId(draft.title, new Date(), persist) : novelId;
  if (autoNovelId) console.log(`小说 ID：${resolvedNovelId}`);
  if (persist && autoNovelId) {
    const normalizedInput = state.normalizedInput?.normalizedInput;
    if (normalizedInput !== undefined) artifacts.saveRawInput(normalizedInput, resolvedNovelId);
  }
  if (persist && existing === null) artifacts.saveDraft(draft, resolvedNovelId);

  const existingConfig = existing === null ? null : artifacts.readLatestBookConfig(novelId);
  const bookConfig = existingConfig === null ? buildBookConfig(draft, new Date(), resolvedNovelId) : { ...existingConfig, novelId: resolvedNovelId };
  if (persist && (existingConfig === null || existingConfig.novelId !== resolvedNovelId)) artifacts.saveBookConfig(bookConfig, resolvedNovelId);
  const rawInput = state.rawInput === undefined
    ? undefined
    : { ...state.rawInput, novel_id: resolvedNovelId, autoNovelId: false };
  return { draft, bookConfig, ...(rawInput === undefined ? {} : { rawInput }) };
}
