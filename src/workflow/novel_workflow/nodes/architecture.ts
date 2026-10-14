import type { ArchitectureAgent } from "../../../novel-flow/architecture";
import type { NovelArtifacts } from "../artifacts";
import type { NovelWorkflowState } from "../state";

/** 汇合故事基础设定与长期创作控制，生成小说静态架构。 */
export async function runArchitecture(
  state: Pick<NovelWorkflowState, "draft" | "storyBible" | "bookRules" | "controls">,
  architectureAgent: ArchitectureAgent,
  persist: boolean,
  novelId: string,
  artifacts: NovelArtifacts,
): Promise<Partial<NovelWorkflowState>> {
  const { draft, storyBible, bookRules, controls } = state;
  if (draft === undefined || storyBible === undefined || bookRules === undefined || controls === undefined) {
    throw new Error("缺少 draft、story_foundation 或 controls 节点产物，无法生成小说静态架构");
  }
  const architecture = await architectureAgent.createArchitecture({ draft, storyBible, bookRules, controls, novelId });
  if (persist) artifacts.saveArchitecture(architecture, novelId);
  return { architecture };
}
