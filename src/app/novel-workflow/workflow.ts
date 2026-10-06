import { ArchitectAgent } from "../../novel-flow/architect";
import { ArchitectureAgent } from "../../novel-flow/architecture";
import { ControlsAgent } from "../../novel-flow/controls";
import { CreativeDraftAgent } from "../../novel-flow/draft/creative-draft-agent";
import { RawInputAgent } from "../../novel-flow/raw-input/raw-input-agent";
import { State0Agent } from "../../novel-flow/state0";
import { buildBookConfig } from "../../novel-flow/book-config";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { CreativeDraftError, ClarifyUserAnswer } from "../../novel-flow/draft/creative-draft-agent";
import { EXAMPLE_RAW_INPUT } from "../../novel-flow/draft/example";
import { EXAMPLE_ARCHITECTURE } from "../../novel-flow/architecture/example";
import { RawInputError } from "../../novel-flow/raw-input/raw-input-agent";
import { INPUT_GUIDE, USAGE } from "../input-guide";
import {
  buildCreativeDraftAgent,
  buildMemoryArchitectAgent,
  buildMemoryArchitectureAgent,
  buildMemoryControlsAgent,
  buildMemoryRawInputAgent,
  buildMemoryState0Agent,
  buildRealArchitectAgent,
  buildRealArchitectureAgent,
  buildRealControlsAgent,
  buildRealCreativeDraftAgent,
  buildRealRawInputAgent,
  buildRealState0Agent,
} from "./agents";
import { runN0Step } from "./steps/n0-raw-input";
import { runN1Step } from "./steps/n1-draft";
import { runN2Only } from "./steps/n2-book-config";
import { runN3Only } from "./steps/n3-story-foundation";
import { runN4Step } from "./steps/n4-controls";
import { runN5Step } from "./steps/n5-architecture";
import { runN6Step } from "./steps/n6-state0";
import { runN7Step } from "./steps/n7-workspace";
import { runN8Step } from "./steps/n8-ready";
import { NovelWorkflowStep } from "./types";
import { saveBookConfig, saveDraft, saveRawInput } from "./artifacts";
import { CliAskerFactory, generateDraft } from "./steps/n1-draft";
import { resolveRawInput } from "./steps/n0-raw-input";
import { runN3N4Parallel } from "./steps/n4-controls";
import { runN5Only } from "./steps/n5-architecture";
import { runN6Only } from "./steps/n6-state0";
import { runN7Only } from "./steps/n7-workspace";

export interface NovelWorkflowOptions {
  n0: RawInputAgent;
  n1: CreativeDraftAgent;
  architect: ArchitectAgent;
  architecture: ArchitectureAgent;
  state0Agent: State0Agent;
  controls: ControlsAgent;
  initialInput: string;
  isReal: boolean;
  ask?: CliAskerFactory;
}

export async function executeNovelWorkflow(options: NovelWorkflowOptions): Promise<void> {
  const { n0, n1, architect, architecture, state0Agent, controls, initialInput, isReal, ask } = options;
  const { rawInput, fromCache } = await resolveRawInput(n0, initialInput);
  if (isReal && !fromCache) {
    saveRawInput(rawInput);
  }

  const draft = await generateDraft(n1, rawInput, ask !== undefined, ask);
  console.log(JSON.stringify(draft, null, 2));
  if (isReal) {
    saveDraft(draft);
  }

  const config = buildBookConfig(draft);
  console.log(`\n【N2 书籍配置】已创建书籍：${config.bookId}（${config.title}）`);
  console.log(JSON.stringify(config, null, 2));
  if (isReal) {
    saveBookConfig(config);
  }

  const parallel = await runN3N4Parallel(architect, controls, draft, isReal);
  const architectureResult = await runN5Only(
    architecture,
    isReal,
    isReal ? undefined : { draft, storyBible: parallel.storyBible, bookRules: parallel.bookRules, controls: parallel.controls },
  );
  const state0Result = await runN6Only(state0Agent, isReal, architectureResult);
  await runN7Only(
    {
      draft,
      bookConfig: config,
      storyBible: parallel.storyBible,
      bookRules: parallel.bookRules,
      controls: parallel.controls,
      architecture: architectureResult,
      state0: state0Result,
    },
    isReal,
    false,
  );

  if (isReal) {
    await runN8Step(config.bookId);
  } else {
    console.log("（memory 模式 N7 为 dry-run 未落盘，跳过 N8 交接）");
  }
}

interface CliArgs {
  /** 直接提供小说原始想法文本。 */
  input?: string;
  /** 从指定文件读取小说原始想法。 */
  file?: string;
  /** 选择内存示例模型或真实模型，缺省使用 memory。 */
  model?: "memory" | "real";
  /** 启用 N1 多轮澄清交互。 */
  clarify?: boolean;
  /** 仅执行指定的 N0～N8 节点，缺省执行全链路。 */
  step?: NovelWorkflowStep;
  /** N7 目标书目录已存在时强制重建。 */
  force?: boolean;
  /** 指定 N8 验收的书籍 ID。 */
  book?: string;
  /** 显示命令帮助和输入建议。 */
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    if (token === "--input" && value !== undefined) {
      args.input = value;
      i += 1;
    } else if (token === "--file" && value !== undefined) {
      args.file = value;
      i += 1;
    } else if (token === "--model" && value !== undefined) {
      if (value !== "memory" && value !== "real") {
        throw new Error(`--model 只支持 memory 或 real，收到：${value}`);
      }
      args.model = value;
      i += 1;
    } else if (token === "--step" && value !== undefined) {
      if (value !== "n0" && value !== "n1" && value !== "n2" && value !== "n3" && value !== "n4" && value !== "n5" && value !== "n6" && value !== "n7" && value !== "n8") {
        throw new Error(`--step 只支持 n0、n1、n2、n3、n4、n5、n6、n7 或 n8，收到：${value}`);
      }
      args.step = value;
      i += 1;
    } else if (token === "--clarify") {
      args.clarify = true;
    } else if (token === "--force") {
      args.force = true;
    } else if (token === "--book" && value !== undefined) {
      args.book = value;
      i += 1;
    } else if (token === "--help") {
      args.help = true;
    } else {
      throw new Error(
        `未知参数：${token}（支持 --input <文本>、--file <路径>、--model memory|real、--step n0|n1|n2|n3|n4|n5|n6|n7|n8、--clarify、--force、--book <bookId>、--help）`,
      );
    }
  }
  return args;
}

function createCliAsker(): { ask: ClarifyUserAnswer; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: async (questions: string[]) => {
      console.log("\n以下是待回答的问题（输入「够了/停止/就这样」可提前结束）：");
      questions.forEach((question, index) => console.log(`  ${index + 1}. ${question}`));
      return new Promise<string>((resolve) =>
        rl.question("你的回答：", (value) => resolve(value.trim())),
      );
    },
    close: () => rl.close(),
  };
}

export async function runNovelWorkflow(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log(USAGE);
    console.log(INPUT_GUIDE);
    return;
  }
  if (args.step === "n2") {
    await runN2Only();
    return;
  }

  const isReal = args.model === "real";
  const n0 = isReal ? buildRealRawInputAgent() : buildMemoryRawInputAgent();
  const n1 = isReal ? buildRealCreativeDraftAgent() : buildCreativeDraftAgent();
  const architect = isReal ? buildRealArchitectAgent() : buildMemoryArchitectAgent();
  const architecture = isReal ? buildRealArchitectureAgent() : buildMemoryArchitectureAgent();
  const state0Agent = isReal ? buildRealState0Agent() : buildMemoryState0Agent();
  const initialInput = args.file !== undefined ? readFileSync(args.file, "utf8") : (args.input ?? EXAMPLE_RAW_INPUT);

  if (!isReal) {
    console.log("（memory 模式：使用预置《隐龙》示例数据演示链路，不调用真实模型、不落盘）\n");
  } else {
    console.log("正在调用真实模型，请稍候（首次可能需要 30~90 秒）...");
  }

  if (args.step === "n0") {
    await runN0Step(n0, initialInput, isReal);
    return;
  }
  if (args.step === "n1") {
    await runN1Step(n1, args.clarify === true ? createCliAsker : undefined, isReal);
    return;
  }
  if (args.step === "n3") {
    await runN3Only(architect, isReal);
    return;
  }
  if (args.step === "n4") {
    await runN4Step(isReal ? buildRealControlsAgent() : buildMemoryControlsAgent(), isReal);
    return;
  }
  if (args.step === "n5") {
    await runN5Step(architecture, isReal);
    return;
  }
  if (args.step === "n6") {
    await runN6Step(state0Agent, isReal, isReal ? undefined : EXAMPLE_ARCHITECTURE);
    return;
  }
  if (args.step === "n7") {
    await runN7Step(isReal, args.force === true);
    return;
  }
  if (args.step === "n8") {
    await runN8Step(args.book);
    return;
  }

  await executeNovelWorkflow({
    n0,
    n1,
    architect,
    architecture,
    state0Agent,
    controls: isReal ? buildRealControlsAgent() : buildMemoryControlsAgent(),
    initialInput,
    isReal,
    ask: args.clarify === true ? createCliAsker : undefined,
  });
}

runNovelWorkflow().catch((error: unknown) => {
  const message =
    error instanceof CreativeDraftError || error instanceof RawInputError || error instanceof Error
      ? error.message
      : String(error);
  console.error(`处理失败：${message}`);
  process.exitCode = 1;
});
