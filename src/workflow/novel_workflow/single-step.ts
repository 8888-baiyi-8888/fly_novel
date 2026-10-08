import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ClarifyUserAnswer } from "../../novel-flow/draft/creative-draft-agent";
import { EXAMPLE_ARCHITECTURE } from "../../novel-flow/architecture/example";
import { N7_WORKSPACE_DIR } from "../../novel-flow/paths";
import {
  createRawInputArtifacts,
  readLatestArchitecture,
  readLatestBookConfig,
  readLatestBookRules,
  readLatestControls,
  readLatestDraft,
  readLatestState0,
  readLatestStoryBible,
} from "./artifacts";
import { runArchitecture } from "./nodes/architecture";
import { runBookConfig } from "./nodes/book-config";
import { runControls } from "./nodes/controls";
import { runDraft } from "./nodes/draft";
import { runNormalizedInput } from "./nodes/normalized-input";
import { runReady } from "./nodes/ready";
import { runState0 } from "./nodes/state";
import { runStoryFoundation } from "./nodes/story-foundation";
import { runWorkspace } from "./nodes/workspace";
import type { NovelWorkflowAgents } from "./workflow";

/** 命令行单步运行使用的阶段标识，与 LangGraph 节点 ID 分离。 */
export type NovelWorkflowStep = "ni" | "dra" | "bc" | "sf" | "con" | "arc" | "sta" | "wor" | "rea";

export interface SingleStepOptions {
  step: NovelWorkflowStep;
  agents: NovelWorkflowAgents;
  initialInput: string;
  novelId?: string;
  artifactRoot: string;
  persist: boolean;
  askUser?: ClarifyUserAnswer;
  forceWorkspace?: boolean;
  bookId?: string;
}

function requireArtifact<T>(value: T | null, description: string): T {
  if (value === null) throw new Error(`缺少${description}产物，请先运行对应前序节点或全链路`);
  return value;
}

function resolveWorkspace(bookId?: string): { bookId: string; workspaceDir: string } {
  const selected = bookId ?? (existsSync(N7_WORKSPACE_DIR) ? readdirSync(N7_WORKSPACE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort()
    .at(-1) : undefined);
  if (selected === undefined) {
    throw new Error("没有找到书籍工作空间，请先运行工作空间节点");
  }
  const workspaceDir = join(N7_WORKSPACE_DIR, selected);
  if (!existsSync(workspaceDir)) throw new Error(`书目录不存在：${workspaceDir}`);
  return { bookId: selected, workspaceDir };
}

/** 复用图节点执行单步；前序产物从 artifacts 读取。 */
export async function runNovelStep(options: SingleStepOptions): Promise<void> {
  const { agents, persist } = options;
  const rawInputArtifacts = createRawInputArtifacts(options.artifactRoot);
  switch (options.step) {
    case "ni": {
      if (options.novelId === undefined) throw new Error("normalized input 单步运行需要 novel_id");
      await runNormalizedInput(
        { rawInput: { userInput: options.initialInput, novel_id: options.novelId }, normalizedInput: undefined },
        agents.normalizedInputAgent,
        persist,
        options.artifactRoot,
      );
      return;
    }
    case "dra": {
      if (options.novelId === undefined) throw new Error("草案单步运行需要 --novel-id");
      console.log(JSON.stringify((await runDraft(
        { normalizedInput: { normalizedInput: requireArtifact(rawInputArtifacts.latestRawInputArtifact(options.novelId), "原始输入整理").content } },
        agents.draftAgent,
        persist,
        options.askUser,
      )).draft, null, 2));
      return;
    }
    case "bc":
      console.log(JSON.stringify(runBookConfig({ draft: requireArtifact(readLatestDraft(), "创意草案") }).bookConfig, null, 2));
      return;
    case "sf":
      console.log(JSON.stringify(await runStoryFoundation(
        {
          draft: requireArtifact(readLatestDraft(), "创意草案"),
          bookConfig: requireArtifact(readLatestBookConfig(), "书籍配置"),
        },
        agents.architectAgent,
        persist,
      ), null, 2));
      return;
    case "con":
      console.log(JSON.stringify(await runControls(
        { draft: requireArtifact(readLatestDraft(), "创意草案") }, agents.controlsAgent, persist,
      ), null, 2));
      return;
    case "arc":
      console.log(JSON.stringify(await runArchitecture(
        {
          draft: requireArtifact(readLatestDraft(), "创意草案"),
          storyBible: requireArtifact(readLatestStoryBible(), "故事圣经"),
          bookRules: requireArtifact(readLatestBookRules(), "书籍规则"),
          controls: requireArtifact(readLatestControls(), "长期创作控制"),
        },
        agents.architectureAgent,
        persist,
      ), null, 2));
      return;
    case "sta":
      console.log(JSON.stringify(await runState0(
        { architecture: persist ? requireArtifact(readLatestArchitecture(), "小说静态架构") : EXAMPLE_ARCHITECTURE },
        agents.state0Agent,
        persist,
      ), null, 2));
      return;
    case "wor":
      console.log(JSON.stringify(runWorkspace(
        {
          draft: requireArtifact(readLatestDraft(), "创意草案"),
          bookConfig: requireArtifact(readLatestBookConfig(), "书籍配置"),
          storyBible: requireArtifact(readLatestStoryBible(), "故事圣经"),
          bookRules: requireArtifact(readLatestBookRules(), "书籍规则"),
          controls: requireArtifact(readLatestControls(), "长期创作控制"),
          architecture: requireArtifact(readLatestArchitecture(), "小说静态架构"),
          state0: requireArtifact(readLatestState0(), "初始运行状态"),
        },
        persist,
        options.forceWorkspace,
      ).workspace, null, 2));
      return;
    case "rea": {
      const workspace = resolveWorkspace(options.bookId);
      const result = runReady({ workspace: { ...workspace, skipped: true, filesWritten: [] } });
      console.log(`交接结果：${result.ready?.status ?? "warn"}`);
      return;
    }
    default: {
      const exhaustive: never = options.step;
      throw new Error(`未知步骤：${exhaustive}`);
    }
  }
}
