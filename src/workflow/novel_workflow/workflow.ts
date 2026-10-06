import { END, START, StateGraph } from "@langchain/langgraph";
import type { NormalizedInputAgent } from "../../novel-flow/normalized-input/normalized-input-agent";
import { runNormalizedInput } from "./nodes/normalized-input";
import { NovelWorkflowSchema, type NovelWorkflowState } from "./state";

/** 建立小说级工作流状态图，并将原始输入 Agent 绑定到对应节点。 */
export function buildNovelGraph(normalizedInputAgent: NormalizedInputAgent) {
  const normalizedInputNode = (state: NovelWorkflowState) =>
    runNormalizedInput(state, normalizedInputAgent);

  const graphWithNodes = new StateGraph(NovelWorkflowSchema)
    .addNode("normalized_input", normalizedInputNode);

  const graphWithEdges = graphWithNodes
    .addEdge(START, "normalized_input")
    .addEdge("normalized_input", END);

  return graphWithEdges.compile();
}
