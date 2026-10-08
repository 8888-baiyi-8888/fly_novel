import type { State0Agent } from "../../../novel-flow/state0";
import { saveState0 } from "../artifacts";
import type { NovelWorkflowState } from "../state";

/** 根据静态架构生成书籍初始运行状态。 */
export async function runState0(
  state: Pick<NovelWorkflowState, "architecture">,
  state0Agent: State0Agent,
  persist = true,
): Promise<Partial<NovelWorkflowState>> {
  if (state.architecture === undefined) {
    throw new Error("缺少 architecture 节点产物，无法生成 State₀");
  }
  const state0 = await state0Agent.createState0(state.architecture);
  if (persist) saveState0(state0);
  return { state0 };
}
