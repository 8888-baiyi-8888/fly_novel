/**原始输入整理节点 */

import { NovelWorkflowState } from "../state";
import { NormalizedInputAgent } from "../../../novel-flow/normalized-input/normalized-input-agent";
import type { NovelArtifacts } from "../artifacts";


export async function runNormalizedInput(
  state: Pick<NovelWorkflowState, "rawInput" | "normalizedInput">,
  normalizedInputAgent: NormalizedInputAgent,
  persist: boolean,
  artifacts: NovelArtifacts,
): Promise<Partial<NovelWorkflowState>> {
  const novelId = state.rawInput.novel_id;
  const existing = state.rawInput.autoNovelId === true ? null : artifacts.latestRawInputArtifact(novelId);

  // 已存在 NI 产物，直接复用
  if (existing !== null) {
    console.log(
      `\n已存在 normalized input 产物：${existing.existing}\n` +
      "（跳过原始输入整理节点，直接作为草案节点输入）\n",
    );
    return { normalizedInput: { normalizedInput: existing.content, rawInputFromCache: true } };
  }

  // 调用 Agent 生成 NI 产物
  const normalizedInput = await normalizedInputAgent.createRawInput(
    state.rawInput.userInput,
  );

  console.log(
    "\n【normalized input 节点 扩展后的原始输入】\n" +
    normalizedInput +
    "\n",
  );

  if (persist && state.rawInput.autoNovelId !== true) artifacts.saveRawInput(normalizedInput, novelId);
  return { normalizedInput: { normalizedInput, rawInputFromCache: false } };
}
