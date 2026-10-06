import { ArchitectAgent } from "../../../novel-flow/architect";
import { BookRules, StoryBible } from "../../../novel-flow/architect/types";
import { ControlsAgent } from "../../../novel-flow/controls";
import { LongTermControls } from "../../../novel-flow/controls/types";
import { CreativeDraft } from "../../../novel-flow/draft/types";
import { readLatestDraft, saveControls } from "../../../workflow/novel_workflow/artifacts";
import { runN3Only } from "./n3-story-foundation";

export async function runN4Only(controls: ControlsAgent, draft: CreativeDraft, persist: boolean): Promise<LongTermControls> {
  const result = await controls.createControls(draft);
  console.log("\n【N4 长期创作控制】");
  console.log(JSON.stringify(result, null, 2));
  if (persist) {
    saveControls(result);
  }
  return result;
}

export async function runN4Step(controls: ControlsAgent, persist: boolean): Promise<void> {
  const draft = readLatestDraft();
  if (draft === null) {
    throw new Error("没有找到 N1 草案（artifacts/n1-draft/），请先运行 --step n1 或全链路");
  }
  await runN4Only(controls, draft, persist);
}

export async function runN3N4Parallel(
  architect: ArchitectAgent,
  controls: ControlsAgent,
  draft: CreativeDraft,
  isReal: boolean,
): Promise<{ storyBible: StoryBible; bookRules: BookRules; controls: LongTermControls }> {
  const [n3, n4] = await Promise.all([
    runN3Only(architect, isReal),
    runN4Only(controls, draft, isReal),
  ]);
  return { storyBible: n3.storyBible, bookRules: n3.bookRules, controls: n4 };
}
