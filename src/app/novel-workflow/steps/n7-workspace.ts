import { buildWorkspace } from "../../../novel-flow/workspace";
import { WorkspaceInputs } from "../../../novel-flow/workspace/types";
import {
  readLatestArchitecture,
  readLatestBookConfig,
  readLatestBookRules,
  readLatestControls,
  readLatestDraft,
  readLatestState0,
  readLatestStoryBible,
} from "../../../workflow/novel_workflow/artifacts";

export async function runN7Only(inputs: WorkspaceInputs, persist: boolean, force: boolean): Promise<void> {
  const result = buildWorkspace(inputs, { force, dryRun: !persist });
  if (result.skipped) {
    console.log(`N7 跳过：书目录已存在（${result.workspaceDir}），要重建请加 --force`);
    return;
  }
  console.log(`\n【N7 持久化工作空间】${persist ? "已生成" : "dry-run 预览（未落盘）"}：${result.workspaceDir}`);
  for (const relPath of result.filesWritten) {
    console.log(`  ${relPath}`);
  }
}

export async function runN7Step(persist: boolean, force: boolean): Promise<void> {
  const draft = readLatestDraft();
  const bookConfig = readLatestBookConfig();
  const storyBible = readLatestStoryBible();
  const bookRules = readLatestBookRules();
  const controls = readLatestControls();
  const architecture = readLatestArchitecture();
  const state0 = readLatestState0();
  const missing: string[] = [];
  if (draft === null) missing.push("N1 草案");
  if (bookConfig === null) missing.push("N2 书籍配置");
  if (storyBible === null) missing.push("N3 故事圣经");
  if (bookRules === null) missing.push("N3 书籍规则");
  if (controls === null) missing.push("N4 长期创作控制");
  if (architecture === null) missing.push("N5 静态架构");
  if (state0 === null) missing.push("N6 State₀");
  if (missing.length > 0) {
    throw new Error(`N7 需要 N1~N6 全部产物，缺少：${missing.join("、")}。请先运行对应节点或全链路。`);
  }
  await runN7Only(
    { draft: draft!, bookConfig: bookConfig!, storyBible: storyBible!, bookRules: bookRules!, controls: controls!, architecture: architecture!, state0: state0! },
    persist,
    force,
  );
}
