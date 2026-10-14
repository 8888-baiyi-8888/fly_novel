import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ClarifyUserAnswer } from "../../novel-flow/draft/creative-draft-agent";
import { EXAMPLE_ARCHITECTURE } from "../../novel-flow/architecture/example";
import { createNovelArtifacts } from "./artifacts";
import { runArchitecture } from "./nodes/architecture";
import { runControls } from "./nodes/controls";
import { runDraft } from "./nodes/draft";
import { runNormalizedInput } from "./nodes/normalized-input";
import { runReady } from "./nodes/ready";
import { runState0 } from "./nodes/state";
import { runStoryFoundation } from "./nodes/story-foundation";
import { runWorkspace } from "./nodes/workspace";
import type { NovelWorkflowAgents } from "./workflow";

/** 命令行单步运行使用的阶段标识，与 LangGraph 节点 ID 分离。 */
export type NovelWorkflowStep = "ni" | "dra" | "sf" | "con" | "arc" | "sta" | "wor" | "rea";

export interface SingleStepOptions {
  step: NovelWorkflowStep;
  agents: NovelWorkflowAgents;
  initialInput: string;
  novelId: string;
  artifactRoot: string;
  persist: boolean;
  askUser?: ClarifyUserAnswer;
  forceWorkspace?: boolean;

}

function requireArtifact<T>(value: T | null, description: string): T {
  if (value === null) throw new Error(`缺少${description}产物，请先运行对应前序节点或全链路`);
  return value;
}

function resolveWorkspace(novelId: string, workspaceDir: string): { novelId: string; workspaceDir: string } {
  if (!existsSync(workspaceDir)) throw new Error(`小说工作区不存在：${workspaceDir}`);
  return { novelId, workspaceDir };
}
/** 复用图节点执行单步；前序产物从 artifacts 读取。 */
export async function runNovelStep(options: SingleStepOptions): Promise<void> {
  const { agents, persist } = options;
  const artifacts = createNovelArtifacts(options.artifactRoot);
  const novelId = options.novelId;
  switch (options.step) {
    case "ni": {
      await runNormalizedInput(
        { rawInput: { userInput: options.initialInput, novel_id: novelId }, normalizedInput: undefined },
        agents.normalizedInputAgent,
        persist,
        artifacts,
      );
      return;
    }
    case "dra": {
      const normalizedInput = artifacts.latestRawInputArtifact(novelId);
      console.log(JSON.stringify(await runDraft(
        { normalizedInput: normalizedInput === null ? undefined : { normalizedInput: normalizedInput.content } },
        agents.draftAgent,
        persist,
        novelId,
        artifacts,
        options.askUser,
      ), null, 2));
      return;
    }
    case "sf":
      console.log(JSON.stringify(await runStoryFoundation(
        {
          draft: requireArtifact(artifacts.readLatestDraft(novelId), "创意草案"),
          bookConfig: requireArtifact(artifacts.readLatestBookConfig(novelId), "书籍配置"),
        },
        agents.architectAgent,
        persist,
        novelId,
        artifacts,
      ), null, 2));
      return;
    case "con":
      console.log(JSON.stringify(await runControls(
        { draft: requireArtifact(artifacts.readLatestDraft(novelId), "创意草案") }, agents.controlsAgent, persist, novelId, artifacts,
      ), null, 2));
      return;
    case "arc":
      console.log(JSON.stringify(await runArchitecture(
        {
          draft: requireArtifact(artifacts.readLatestDraft(novelId), "创意草案"),
          storyBible: requireArtifact(artifacts.readLatestStoryBible(novelId), "故事圣经"),
          bookRules: requireArtifact(artifacts.readLatestBookRules(novelId), "书籍规则"),
          controls: requireArtifact(artifacts.readLatestControls(novelId), "长期创作控制"),
        },
        agents.architectureAgent,
        persist,
        novelId,
        artifacts,
      ), null, 2));
      return;
    case "sta":
      console.log(JSON.stringify(await runState0(
        { architecture: persist ? requireArtifact(artifacts.readLatestArchitecture(novelId), "小说静态架构") : EXAMPLE_ARCHITECTURE },
        agents.state0Agent,
        persist,
        novelId,
        artifacts,
      ), null, 2));
      return;
    case "wor":
      console.log(JSON.stringify(runWorkspace(
        {
          draft: requireArtifact(artifacts.readLatestDraft(novelId), "创意草案"),
          bookConfig: requireArtifact(artifacts.readLatestBookConfig(novelId), "书籍配置"),
          storyBible: requireArtifact(artifacts.readLatestStoryBible(novelId), "故事圣经"),
          bookRules: requireArtifact(artifacts.readLatestBookRules(novelId), "书籍规则"),
          controls: requireArtifact(artifacts.readLatestControls(novelId), "长期创作控制"),
          architecture: requireArtifact(artifacts.readLatestArchitecture(novelId), "小说静态架构"),
          state0: requireArtifact(artifacts.readLatestState0(novelId), "初始运行状态"),
        },
        persist,
        options.forceWorkspace ?? false,
        novelId,
        artifacts,
      ).workspace, null, 2));
      return;
    case "rea": {
      const workspace = resolveWorkspace(novelId, artifacts.workspaceRoot(novelId));
      const result = runReady({ workspace: { ...workspace, skipped: true, filesWritten: [] } }, true, novelId, artifacts);
      console.log(`交接结果：${result.ready?.status ?? "warn"}`);
      return;
    }
    default: {
      const exhaustive: never = options.step;
      throw new Error(`未知步骤：${exhaustive}`);
    }
  }
}
