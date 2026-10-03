import { MemoryModel } from "../../novel-flow/adapters/memory-model";
import { ArchitectureAgent, DirectorAgent, StoryArchitectAgent } from "../../novel-flow/architecture";
import { EXAMPLE_ARCHITECTURE_JSON, EXAMPLE_BEAT_BOARD_JSON } from "../../novel-flow/architecture/example";
import { ArchitectAgent } from "../../novel-flow/architect";
import { EXAMPLE_ARCHITECT_JSON } from "../../novel-flow/architect/example";
import { ControlsAgent } from "../../novel-flow/controls";
import { EXAMPLE_CONTROLS_JSON } from "../../novel-flow/controls/example";
import { CreativeDraftAgent } from "../../novel-flow/draft/creative-draft-agent";
import { EXAMPLE_DRAFT_JSON, EXAMPLE_RAW_INPUT } from "../../novel-flow/draft/example";
import { RawInputAgent } from "../../novel-flow/raw-input/raw-input-agent";
import { State0Agent } from "../../novel-flow/state0";
import { EXAMPLE_STATE0_JSON } from "../../novel-flow/state0/example";
import { ConfiguredLlmModel } from "../configured-model";

/** 组装内存模型版创意草案 Agent。 */
export function buildCreativeDraftAgent(): CreativeDraftAgent {
  const model = new MemoryModel({ responses: { creative_draft: EXAMPLE_DRAFT_JSON } });
  return new CreativeDraftAgent({ model, maxRetries: 3 });
}

/** 组装内存模型版架构师基础设定 Agent。 */
export function buildMemoryArchitectAgent(): ArchitectAgent {
  const model = new MemoryModel({ responses: { architect_foundation: EXAMPLE_ARCHITECT_JSON } });
  return new ArchitectAgent({ model, maxRetries: 3 });
}

/** 组装内存模型版长期创作控制 Agent。 */
export function buildMemoryControlsAgent(): ControlsAgent {
  const model = new MemoryModel({ responses: { creative_controls: EXAMPLE_CONTROLS_JSON } });
  return new ControlsAgent({ model, maxRetries: 3 });
}

/** 组装内存模型版小说静态架构 Agent。 */
export function buildMemoryArchitectureAgent(): ArchitectureAgent {
  const architect = new StoryArchitectAgent({
    model: new MemoryModel({ responses: { story_architecture: EXAMPLE_ARCHITECTURE_JSON } }),
  });
  const director = new DirectorAgent({
    model: new MemoryModel({ responses: { beat_board: EXAMPLE_BEAT_BOARD_JSON } }),
  });
  return new ArchitectureAgent(architect, director);
}

/** 组装内存模型版 State₀ Agent。 */
export function buildMemoryState0Agent(): State0Agent {
  const model = new MemoryModel({ responses: { state0: EXAMPLE_STATE0_JSON } });
  return new State0Agent({ model, maxRetries: 3 });
}

/** 组装内存模型版原始输入 Agent。 */
export function buildMemoryRawInputAgent(): RawInputAgent {
  const model = new MemoryModel({ responses: { raw_input: JSON.stringify({ rawInput: EXAMPLE_RAW_INPUT }) } });
  return new RawInputAgent({ model, maxRetries: 3 });
}

/** 组装真实模型版 N0 原始输入 Agent。 */
export function buildRealRawInputAgent(): RawInputAgent {
  const model = new ConfiguredLlmModel({ provider: "deepseek", timeoutMs: 180_000 });
  return new RawInputAgent({ model, maxRetries: 3 });
}

/** 组装真实模型版 N1 创意草案 Agent。 */
export function buildRealCreativeDraftAgent(): CreativeDraftAgent {
  const model = new ConfiguredLlmModel({ provider: "deepseek", timeoutMs: 180_000 });
  return new CreativeDraftAgent({ model, maxRetries: 3 });
}

/** 组装真实模型版 N3 架构师基础设定 Agent。 */
export function buildRealArchitectAgent(): ArchitectAgent {
  const model = new ConfiguredLlmModel({ provider: "deepseek", timeoutMs: 180_000 });
  return new ArchitectAgent({ model, maxRetries: 3 });
}

/** 组装真实模型版 N4 长期创作控制 Agent。 */
export function buildRealControlsAgent(): ControlsAgent {
  const model = new ConfiguredLlmModel({ provider: "deepseek", timeoutMs: 180_000 });
  return new ControlsAgent({ model, maxRetries: 3 });
}

/** 组装真实模型版 N5 小说静态架构 Agent。 */
export function buildRealArchitectureAgent(): ArchitectureAgent {
  const architect = new StoryArchitectAgent({
    model: new ConfiguredLlmModel({ provider: "deepseek", timeoutMs: 480_000 }),
    maxRetries: 3,
  });
  const director = new DirectorAgent({
    model: new ConfiguredLlmModel({ provider: "deepseek", timeoutMs: 600_000 }),
    maxRetries: 3,
    chunked: true,
    wholeBoardRetries: 2,
  });
  return new ArchitectureAgent(architect, director);
}

/** 组装真实模型版 N6 State₀ Agent。 */
export function buildRealState0Agent(): State0Agent {
  const model = new ConfiguredLlmModel({ provider: "deepseek", timeoutMs: 180_000 });
  return new State0Agent({ model, maxRetries: 3 });
}
