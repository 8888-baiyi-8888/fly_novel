import type { ControlsAgent } from "../../../novel-flow/controls";
import type { NovelArtifacts } from "../artifacts";
import type { NovelWorkflowState } from "../state";

/** 从创意草案生成长期创作控制。 */
export async function runControls(
  state: Pick<NovelWorkflowState, "draft">,
  controlsAgent: ControlsAgent,
  persist: boolean,
  novelId: string,
  artifacts: NovelArtifacts,
): Promise<Partial<NovelWorkflowState>> {
  if (state.draft === undefined) {
    throw new Error("缺少 draft 节点产物，无法生成长期创作控制");
  }
  const controls = await controlsAgent.createControls(state.draft);
  if (persist) artifacts.saveControls(controls, novelId);
  return { controls };
}
