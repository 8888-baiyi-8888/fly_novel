import { END, START, StateGraph } from "@langchain/langgraph";
import type { ArchitectAgent } from "../../novel-flow/architect";
import type { ArchitectureAgent } from "../../novel-flow/architecture";
import type { ControlsAgent } from "../../novel-flow/controls";
import type { ClarifyUserAnswer, CreativeDraftAgent } from "../../novel-flow/draft/creative-draft-agent";
import type { NormalizedInputAgent } from "../../novel-flow/normalized-input/normalized-input-agent";
import type { State0Agent } from "../../novel-flow/state0";
import { runArchitecture } from "./nodes/architecture";
import { runBookConfig } from "./nodes/book-config";
import { runControls } from "./nodes/controls";
import { runDraft } from "./nodes/draft";
import { runNormalizedInput } from "./nodes/normalized-input";
import { runReady } from "./nodes/ready";
import { runState0 } from "./nodes/state";
import { runStoryFoundation } from "./nodes/story-foundation";
import { runWorkspace } from "./nodes/workspace";
import { NovelWorkflowSchema, type NovelWorkflowState } from "./state";

/** 建书流程需要的 Agent 实例，由调用方创建。 */
export interface NovelWorkflowAgents {
  normalizedInputAgent: NormalizedInputAgent;
  draftAgent: CreativeDraftAgent;
  architectAgent: ArchitectAgent;
  controlsAgent: ControlsAgent;
  architectureAgent: ArchitectureAgent;
  state0Agent: State0Agent;
}

export interface NovelWorkflowRunOptions {
  /** normalized input 产物的根目录。 */
  artifactRoot: string;
  /** 是否写入产物和书目录；内存模型预览时传 false。 */
  persist?: boolean;
  /** 草案生成前的澄清回调；省略时直接生成。 */
  askUser?: ClarifyUserAnswer;
  /** 书目录已存在时是否重建。 */
  forceWorkspace?: boolean;
}

/** 建立小说级工作流状态图，并将 Agent 绑定到对应节点。 */
export function buildNovelGraph(deps: NovelWorkflowAgents, options: NovelWorkflowRunOptions) {
  const persist = options.persist ?? true;
  const normalizedInputNode = (state: NovelWorkflowState) =>
    runNormalizedInput(state, deps.normalizedInputAgent, persist, options.artifactRoot);
  const draftNode = (state: NovelWorkflowState) =>
    runDraft(state, deps.draftAgent, persist, options.askUser);
  const bookConfigNode = (state: NovelWorkflowState) => runBookConfig(state, persist);
  const storyFoundationNode = (state: NovelWorkflowState) =>
    runStoryFoundation(state, deps.architectAgent, persist);
  const controlsNode = (state: NovelWorkflowState) => runControls(state, deps.controlsAgent, persist);
  const architectureNode = (state: NovelWorkflowState) =>
    runArchitecture(state, deps.architectureAgent, persist);
  const state0Node = (state: NovelWorkflowState) => runState0(state, deps.state0Agent, persist);
  const workspaceNode = (state: NovelWorkflowState) =>
    runWorkspace(state, persist, options.forceWorkspace);
  const readyNode = (state: NovelWorkflowState) => runReady(state, persist);

  const graphWithNodes = new StateGraph(NovelWorkflowSchema)
    .addNode("normalized_input", normalizedInputNode)
    .addNode("draft_node", draftNode)
    .addNode("book_config", bookConfigNode)
    .addNode("story_foundation", storyFoundationNode)
    .addNode("controls_node", controlsNode)
    .addNode("architecture_node", architectureNode)
    .addNode("state0_node", state0Node)
    .addNode("workspace_node", workspaceNode)
    .addNode("ready_node", readyNode);

  const graphWithEdges = graphWithNodes
    .addEdge(START, "normalized_input")
    .addEdge("normalized_input", "draft_node")
    .addEdge("draft_node", "book_config")
    .addEdge("draft_node", "controls_node")
    .addEdge("book_config", "story_foundation")
    .addEdge(["story_foundation", "controls_node"], "architecture_node")
    .addEdge("architecture_node", "state0_node")
    .addEdge("state0_node", "workspace_node")
    .addEdge("workspace_node", "ready_node")
    .addEdge("ready_node", END);

  return graphWithEdges.compile();
}
