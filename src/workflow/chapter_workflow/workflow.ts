import { END, START, StateGraph } from "@langchain/langgraph";
import type { NovelId, ChapterState } from "../../novel/types";
import type { BookRuntime } from "../../novel/runtime";
import type { AgentPort, ContentAgent } from "../agent-port";
import { createJsonFileStore } from "../file-store";
import {
  createAuditGraphNode,
  createCensorGraphNode,
  createDirectGraphNode,
  createMergeGraphNode,
  createSettleGraphNode,
  createSimulateGraphNode,
  createTransitionNode,
  createWriteGraphNode,
} from "./nodes";
import type { ChapterRunResult, WorkflowEvent, WorkflowStore } from "../types";
import { ChapterGraphStateSchema, type ChapterGraphState } from "./state";
import type { CharacterSimulationAgent } from "./nodes/simulate";

export interface ChapterGraphOptions {
  /** merge 与 settle 使用的通用模型端口。 */
  readonly agent: AgentPort;
  /** direct、write、audit、censor 节点分别直接使用对应的专用 Agent。 */
  readonly directorAgent: ContentAgent;
  readonly writerAgent: ContentAgent;
  readonly auditAgent: ContentAgent;
  readonly censorAgent: ContentAgent;
  readonly characterAgents: CharacterSimulationAgent;
  readonly runtime: BookRuntime;
  readonly store: WorkflowStore;
  readonly maxRetries: number;
  readonly notify?: (event: WorkflowEvent) => void;
}

/** 建立章节 LangGraph；节点行为由现有节点工厂提供，图负责状态流转和重试路由。 */
export function buildChapterGraph(options: ChapterGraphOptions) {
  const { agent, runtime, store, maxRetries, notify } = options;
  const directNode = createDirectGraphNode(options.directorAgent, { runtime });
  const simulateNode = createSimulateGraphNode(options.characterAgents, runtime);
  const mergeNode = createMergeGraphNode(agent);
  const writeNode = createWriteGraphNode(options.writerAgent);
  const auditNode = createAuditGraphNode(options.auditAgent);
  const censorNode = createCensorGraphNode(options.censorAgent);
  const settleNode = createSettleGraphNode(agent, { runtime });
  const transitionNode = createTransitionNode({ store, maxRetries, notify });

  const graph = new StateGraph(ChapterGraphStateSchema)
    .addNode("direct", directNode)
    .addNode("simulate", simulateNode)
    .addNode("merge", mergeNode)
    .addNode("write", writeNode)
    .addNode("audit", auditNode)
    .addNode("censor", censorNode)
    .addNode("settle", settleNode)
    .addNode("transition", transitionNode)
    .addEdge("direct", "transition")
    .addEdge("simulate", "transition")
    .addEdge("merge", "transition")
    .addEdge("write", "transition")
    .addEdge("audit", "transition")
    .addEdge("censor", "transition")
    .addEdge("settle", "transition")
    .addConditionalEdges("transition", (state) => {
    if (state.resultKind !== undefined) return END;
    return state.step;
    })
    .addConditionalEdges(START, (state) => state.step);
  return graph.compile();
}

export interface RunChapterGraphOptions extends Omit<ChapterGraphOptions, "store"> {
  readonly store?: WorkflowStore;
  readonly storeDir?: string;
}

/** 从 JsonFileStore 恢复章节状态并运行 LangGraph。 */
export async function runChapterGraph(novelId: NovelId, chapter: number, options: RunChapterGraphOptions): Promise<ChapterRunResult> {
  const store = options.store ?? createJsonFileStore({ dir: options.storeDir ?? ".fly-novel-store" });
  const persisted = await store.load(novelId, chapter);
  if (persisted?.state.status === "settled" || persisted?.state.status === "approved") {
    return { kind: "already-complete", state: persisted.state };
  }
  const initial: ChapterGraphState = persisted === undefined
    ? { novelId, chapter, step: "direct", status: "planned", retries: 0, artifacts: {}, outcome: undefined, resultKind: undefined, reason: undefined }
    : { ...persisted.state, artifacts: persisted.artifacts, outcome: undefined, resultKind: undefined, reason: undefined };
  const result = await buildChapterGraph({ ...options, store }).invoke(initial);
  if (result.resultKind === "invalid") return { kind: "invalid", reason: result.reason ?? "章节图状态无效" };
  const state: ChapterState = { novelId, chapter, step: result.step, status: result.status, retries: result.retries };
  if (result.resultKind === "completed" || result.resultKind === "already-complete") return { kind: result.resultKind, state };
  if (result.resultKind === "suspended" || result.resultKind === "failed") {
    return { kind: result.resultKind, state, reason: result.reason ?? "章节工作流停止" };
  }
  return { kind: "invalid", reason: "章节图未产生终态" };
}
