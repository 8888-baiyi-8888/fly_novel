import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { CreativeDraftError, ClarifyUserAnswer } from "../../novel-flow/draft/creative-draft-agent";
import { EXAMPLE_RAW_INPUT } from "../../novel-flow/draft/example";
import { RawInputError } from "../../novel-flow/normalized-input/normalized-input-agent";
import { ARTIFACTS_ROOT } from "../../novel-flow/paths";
import { INPUT_GUIDE, USAGE } from "../input-guide";
import {
  buildMemoryDraftAgent,
  buildMemoryArchitectAgent,
  buildMemoryArchitectureAgent,
  buildMemoryControlsAgent,
  buildMemoryNormalizedInputAgent,
  buildMemoryState0Agent,
  buildRealArchitectAgent,
  buildRealArchitectureAgent,
  buildRealControlsAgent,
  buildRealDraftAgent,
  buildRealNormalizedInputAgent,
  buildRealState0Agent,
} from "./agents";
import { buildNovelGraph, type NovelWorkflowAgents } from "../../workflow/novel_workflow";
import { runNovelStep, type NovelWorkflowStep } from "../../workflow/novel_workflow/single-step";

type CliAskerFactory = () => { ask: ClarifyUserAnswer; close: () => void };

export interface NovelWorkflowOptions {
  agents: NovelWorkflowAgents;
  initialInput: string;
  novelId?: string;
  isReal: boolean;
  ask?: CliAskerFactory;
  forceWorkspace?: boolean;
}

export async function executeNovelWorkflow(options: NovelWorkflowOptions): Promise<void> {
  const asker = options.ask?.();
  try {
    const novelId = options.novelId ?? randomUUID();
    console.log(`小说 ID：${novelId}`);
    const graph = buildNovelGraph(
      options.agents,
      { artifactRoot: ARTIFACTS_ROOT, persist: options.isReal, askUser: asker?.ask, forceWorkspace: options.forceWorkspace },
    );
    const result = await graph.invoke({ rawInput: { userInput: options.initialInput, novel_id: novelId } });
    const title = result.bookConfig?.title ?? "未命名书籍";
    const location = result.workspace?.workspaceDir ?? "未生成书目录";
    console.log(`\n建书流程完成：${title}（${options.isReal ? location : "内存预览"}）`);
    if (options.isReal) console.log(`交接状态：${result.ready?.status ?? "warn"}`);
  } finally {
    asker?.close();
  }
}

interface CliArgs {
  /** 直接提供小说原始想法文本。 */
  input?: string;
  /** 从指定文件读取小说原始想法。 */
  file?: string;
  /** 指定小说 ID，续跑同一小说时复用。 */
  novelId?: string;
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
    } else if (token === "--novel-id" && value !== undefined) {
      args.novelId = value;
      i += 1;
    } else if (token === "--model" && value !== undefined) {
      if (value !== "memory" && value !== "real") {
        throw new Error(`--model 只支持 memory 或 real，收到：${value}`);
      }
      args.model = value;
      i += 1;
    } else if (token === "--step" && value !== undefined) {
      if (value !== "ni" && value !== "dra" && value !== "bc" && value !== "sf" && value !== "con" && value !== "arc" && value !== "sta" && value !== "wor" && value !== "rea") {
        throw new Error(`--step 只支持 ni、dra、bc、sf、con、arc、sta、wor 或 rea，收到：${value}`);
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
        `未知参数：${token}（支持 --input <文本>、--file <路径>、--novel-id <ID>、--model memory|real、--step ni|dra|bc|sf|con|arc|sta|wor|rea、--clarify、--force、--book <bookId>、--help）`,
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

export async function runNovelWorkflow(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.help === true) {
    console.log(USAGE);
    console.log("  --novel-id <ID>       指定小说 ID；草案单步运行时必须传入 normalized input 使用的 ID");
    console.log(INPUT_GUIDE);
    return;
  }
  if (args.step === "dra" && args.novelId === undefined) {
    throw new Error("草案单步运行需要 --novel-id <ID>");
  }
  const isReal = args.model === "real";
  const agents: NovelWorkflowAgents = {
    normalizedInputAgent: isReal ? buildRealNormalizedInputAgent() : buildMemoryNormalizedInputAgent(),
    draftAgent: isReal ? buildRealDraftAgent() : buildMemoryDraftAgent(),
    architectAgent: isReal ? buildRealArchitectAgent() : buildMemoryArchitectAgent(),
    controlsAgent: isReal ? buildRealControlsAgent() : buildMemoryControlsAgent(),
    architectureAgent: isReal ? buildRealArchitectureAgent() : buildMemoryArchitectureAgent(),
    state0Agent: isReal ? buildRealState0Agent() : buildMemoryState0Agent(),
  };
  const initialInput = args.file !== undefined ? readFileSync(args.file, "utf8") : (args.input ?? EXAMPLE_RAW_INPUT);

  if (!isReal) {
    console.log("（memory 模式：使用预置《隐龙》示例数据，不调用真实模型；全链路只预览、不落盘）\n");
  } else {
    console.log("正在调用真实模型，请稍候（首次可能需要 30~90 秒）...");
  }

  if (args.step !== undefined) {
    const novelId = args.novelId ?? (args.step === "ni" ? randomUUID() : undefined);
    if (args.step === "ni") console.log(`小说 ID：${novelId}`);
    const asker = args.step === "dra" && args.clarify === true ? createCliAsker() : undefined;
    try {
      await runNovelStep({
        step: args.step,
        agents,
        initialInput,
        novelId,
        artifactRoot: ARTIFACTS_ROOT,
        persist: isReal,
        askUser: asker?.ask,
        forceWorkspace: args.force,
        bookId: args.book,
      });
    } finally {
      asker?.close();
    }
    return;
  }

  await executeNovelWorkflow({
    agents,
    initialInput,
    novelId: args.novelId,
    isReal,
    ask: args.clarify === true ? createCliAsker : undefined,
    forceWorkspace: args.force,
  });
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  runNovelWorkflow(argv.length > 0 ? argv : [
    "--model", "real",
    "--novel-id", "bf552107-18ce-4e81-962f-7b31c5d521d9",
    "--input", "我想写一部都市悬疑小说。主角是一名刚入职的档案管理员，在整理旧案卷时发现十年前一宗失踪案的照片里出现了现在的自己。她起初以为照片被人伪造，却陆续找到只有她知道的童年细节。故事围绕她追查失踪者、怀疑自己的记忆展开；希望悬念逐步揭开，人物的选择有合理动机，结局解释照片的来历。计划写约80章，每章2500字。",
  ]).catch((error: unknown) => {
    const message =
      error instanceof CreativeDraftError || error instanceof RawInputError || error instanceof Error
        ? error.message
        : String(error);
    console.error(`处理失败：${message}`);
    process.exitCode = 1;
  });
}
