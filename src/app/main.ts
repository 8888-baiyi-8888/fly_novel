import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { MemoryModel } from "../harness/adapters/models/memory-model";
import { CreativeDraft } from "../novel/draft/types";
import { CreativeDraftAgent, CreativeDraftError, ClarifyUserAnswer } from "../novel/draft/creative-draft-agent";
import { EXAMPLE_DRAFT_JSON, EXAMPLE_RAW_INPUT } from "../novel/draft/example";
import { RawInputAgent, RawInputError } from "../novel/raw-input/raw-input-agent";
import { buildBookConfig, BookConfig } from "../novel/book-config";
import { ArchitectAgent, ArchitectError, buildBookRules, buildCreativeBrief } from "../novel/architect";
import { EXAMPLE_ARCHITECT_JSON } from "../novel/architect/example";
import { BookRules, StoryBible } from "../novel/architect/types";
import { ControlsAgent, ControlsError } from "../novel/controls";
import { EXAMPLE_CONTROLS_JSON } from "../novel/controls/example";
import { LongTermControls } from "../novel/controls/types";
import { ArchitectureAgent, DirectorAgent, StoryArchitectAgent } from "../novel/architecture";
import { EXAMPLE_ARCHITECTURE, EXAMPLE_ARCHITECTURE_JSON, EXAMPLE_BEAT_BOARD_JSON } from "../novel/architecture/example";
import { StoryArchitecture } from "../novel/architecture/types";
import { State0Agent } from "../novel/state0";
import { EXAMPLE_STATE0_JSON } from "../novel/state0/example";
import { State0 } from "../novel/state0/types";
import { buildWorkspace, verifyWorkspace, scanAndFixRedlines } from "../novel/workspace";
import { WorkspaceInputs } from "../novel/workspace/types";
import {
  N0_RAW_INPUT_DIR,
  N1_DRAFT_DIR,
  N2_BOOK_CONFIG_DIR,
  N3_STORY_BIBLE_DIR,
  N4_CONTROLS_DIR,
  N5_ARCHITECTURE_DIR,
  N6_STATE0_DIR,
  N7_WORKSPACE_DIR,
} from "../config/paths";
import { ConfiguredLlmModel } from "./configured-model";
import { INPUT_GUIDE, USAGE } from "./input-guide";

/**
 * 组装「创意草案整理」应用 —— 内存模型版（演示/测试）。
 * 使用 MemoryModel 返回预置的《隐龙》草案 JSON，不发起真实网络请求。
 */
export function buildCreativeDraftAgent(): CreativeDraftAgent {
  const model = new MemoryModel({ responses: { creative_draft: EXAMPLE_DRAFT_JSON } });
  return new CreativeDraftAgent({ model });
}

/**
 * 组装「架构师基础设定」应用 —— 内存模型版（演示/测试）。
 * 使用 MemoryModel 返回预置的《隐龙》故事圣经与书籍规则，不发起真实网络请求。
 */
export function buildMemoryArchitectAgent(): ArchitectAgent {
  const model = new MemoryModel({
    responses: { architect_foundation: EXAMPLE_ARCHITECT_JSON },
  });
  return new ArchitectAgent({ model });
}

/**
 * 组装「长期创作控制」应用 —— 内存模型版（演示/测试）。
 * 使用 MemoryModel 返回预置的《隐龙》四件套，不发起真实网络请求。
 */
export function buildMemoryControlsAgent(): ControlsAgent {
  const model = new MemoryModel({
    responses: { creative_controls: EXAMPLE_CONTROLS_JSON },
  });
  return new ControlsAgent({ model });
}

/**
 * 组装「小说静态架构」应用 —— 内存模型版（演示/测试）。
 * 架构师（前四件）与 Director（节拍板）都用 MemoryModel 返回预置《隐龙》五件套。
 */
export function buildMemoryArchitectureAgent(): ArchitectureAgent {
  const architect = new StoryArchitectAgent({
    model: new MemoryModel({ responses: { story_architecture: EXAMPLE_ARCHITECTURE_JSON } }),
  });
  const director = new DirectorAgent({
    model: new MemoryModel({ responses: { beat_board: EXAMPLE_BEAT_BOARD_JSON } }),
  });
  return new ArchitectureAgent(architect, director);
}

/**
 * 组装「初始化运行状态」应用 —— 内存模型版（演示/测试）。
 * TruthOracle + Hook Ledger 用 MemoryModel 返回预置《隐龙》State₀。
 */
export function buildMemoryState0Agent(): State0Agent {
  const model = new MemoryModel({
    responses: { state0: EXAMPLE_STATE0_JSON },
  });
  return new State0Agent({ model });
}

/**
 * 组装「原始输入整理」应用 —— 内存模型版（演示/测试）。
 * 使用 MemoryModel 返回预置的《隐龙》原始输入，不发起真实网络请求。
 */
export function buildMemoryRawInputAgent(): RawInputAgent {
  const model = new MemoryModel({
    responses: { raw_input: JSON.stringify({ rawInput: EXAMPLE_RAW_INPUT }) },
  });
  return new RawInputAgent({ model });
}

/**
 * 组装「原始输入整理」应用 —— 真实模型版（N0，当前使用 qwen）。
 * 走项目正式 LLM 机制：src/config 读取并解密凭据，src/llm 适配器路由。
 */
export function buildRealRawInputAgent(): RawInputAgent {
  const model = new ConfiguredLlmModel({ provider: "qwen", timeoutMs: 180_000 });
  return new RawInputAgent({ model });
}

/**
 * 组装「创意草案整理」应用 —— 真实模型版（N1，当前使用 qwen）。
 * 原实现（.env 明文 key + harness 自建 OpenAICompatibleModel）已弃用，见 git 历史；按需可回切。
 */
export function buildRealCreativeDraftAgent(): CreativeDraftAgent {
  const model = new ConfiguredLlmModel({ provider: "qwen", timeoutMs: 180_000 });
  return new CreativeDraftAgent({ model });
}

/**
 * 组装「架构师基础设定」应用 —— 真实模型版（N3，当前使用 qwen）。
 */
export function buildRealArchitectAgent(): ArchitectAgent {
  const model = new ConfiguredLlmModel({ provider: "qwen", timeoutMs: 180_000 });
  return new ArchitectAgent({ model });
}

/**
 * 组装「长期创作控制」应用 —— 真实模型版（N4，当前使用 qwen）。
 */
export function buildRealControlsAgent(): ControlsAgent {
  const model = new ConfiguredLlmModel({ provider: "qwen", timeoutMs: 180_000 });
  return new ControlsAgent({ model });
}

/**
 * 组装「小说静态架构」应用 —— 真实模型版（N5，当前使用 qwen）。
 * 架构师与 Director 各一次调用，共用 qwen 模型。
 */
export function buildRealArchitectureAgent(): ArchitectureAgent {
  const architect = new StoryArchitectAgent({
    model: new ConfiguredLlmModel({ provider: "qwen", timeoutMs: 180_000 }),
  });
  const director = new DirectorAgent({
    model: new ConfiguredLlmModel({ provider: "qwen", timeoutMs: 180_000 }),
  });
  return new ArchitectureAgent(architect, director);
}

/**
 * 组装「初始化运行状态」应用 —— 真实模型版（N6，当前使用 qwen）。
 */
export function buildRealState0Agent(): State0Agent {
  const model = new ConfiguredLlmModel({ provider: "qwen", timeoutMs: 180_000 });
  return new State0Agent({ model });
}

type Step = "n0" | "n1" | "n2" | "n3" | "n4" | "n5" | "n6" | "n7" | "n8";

interface CliArgs {
  input?: string;
  file?: string;
  model?: "memory" | "real";
  clarify?: boolean;
  step?: Step;
  force?: boolean;
  book?: string;
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

/** CLI 澄清问答实现：打印问题列表，用 readline 读一行回答。 */
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

/** 时间戳文件名片段：YYYYMMDD-HHmmss。 */
function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** 落盘 N0 原始输入文本到 artifacts/n0-raw-input/。 */
function saveRawInput(rawInput: string): string {
  mkdirSync(N0_RAW_INPUT_DIR, { recursive: true });
  const path = join(N0_RAW_INPUT_DIR, `raw-input-${timestamp()}.md`);
  writeFileSync(path, rawInput, "utf8");
  console.log(`\n已保存 N0 原始输入到：${path}`);
  return path;
}

/** 落盘 N1 创意草案到 artifacts/n1-draft/。 */
function saveDraft(draft: CreativeDraft): string {
  mkdirSync(N1_DRAFT_DIR, { recursive: true });
  const path = join(N1_DRAFT_DIR, `draft-${timestamp()}.json`);
  writeFileSync(path, JSON.stringify(draft, null, 2), "utf8");
  console.log(`已保存 N1 草案到：${path}`);
  return path;
}

/** 落盘 N2 书籍配置到 artifacts/n2-book-config/。 */
function saveBookConfig(config: BookConfig): string {
  mkdirSync(N2_BOOK_CONFIG_DIR, { recursive: true });
  const path = join(N2_BOOK_CONFIG_DIR, `book-config-${timestamp()}.json`);
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
  console.log(`已保存 N2 书籍配置到：${path}`);
  return path;
}

/** 落盘 N3 故事圣经到 artifacts/n3-story-bible/。 */
function saveStoryBible(bible: StoryBible): string {
  mkdirSync(N3_STORY_BIBLE_DIR, { recursive: true });
  const path = join(N3_STORY_BIBLE_DIR, `story-bible-${timestamp()}.json`);
  writeFileSync(path, JSON.stringify(bible, null, 2), "utf8");
  console.log(`已保存 N3 故事圣经到：${path}`);
  return path;
}

/** 落盘 N3 书籍规则到 artifacts/n3-story-bible/。 */
function saveBookRulesDoc(rules: BookRules): string {
  mkdirSync(N3_STORY_BIBLE_DIR, { recursive: true });
  const path = join(N3_STORY_BIBLE_DIR, `book-rules-${timestamp()}.json`);
  writeFileSync(path, JSON.stringify(rules, null, 2), "utf8");
  console.log(`已保存 N3 书籍规则到：${path}`);
  return path;
}

/** 落盘 N4 长期创作控制到 artifacts/n4-controls/。 */
function saveControls(controls: LongTermControls): string {
  mkdirSync(N4_CONTROLS_DIR, { recursive: true });
  const path = join(N4_CONTROLS_DIR, `controls-${timestamp()}.json`);
  writeFileSync(path, JSON.stringify(controls, null, 2), "utf8");
  console.log(`已保存 N4 长期创作控制到：${path}`);
  return path;
}

/** 落盘 N5 小说静态架构到 artifacts/n5-architecture/。 */
function saveArchitecture(architecture: StoryArchitecture): string {
  mkdirSync(N5_ARCHITECTURE_DIR, { recursive: true });
  const path = join(N5_ARCHITECTURE_DIR, `architecture-${timestamp()}.json`);
  writeFileSync(path, JSON.stringify(architecture, null, 2), "utf8");
  console.log(`已保存 N5 小说静态架构到：${path}`);
  return path;
}

/** 落盘 N6 State₀ 到 artifacts/n6-state0/。 */
function saveState0(state0: State0): string {
  mkdirSync(N6_STATE0_DIR, { recursive: true });
  const path = join(N6_STATE0_DIR, `state0-${timestamp()}.json`);
  writeFileSync(path, JSON.stringify(state0, null, 2), "utf8");
  console.log(`已保存 N6 State₀ 到：${path}`);
  return path;
}

/** 读取 artifacts/n0-raw-input/ 下最新的 N0 产物文件名；无产物返回 null。 */
function latestRawInputArtifact(): string | null {
  mkdirSync(N0_RAW_INPUT_DIR, { recursive: true });
  const files = readdirSync(N0_RAW_INPUT_DIR, { encoding: "utf8" })
    .filter((name) => name.startsWith("raw-input-") && name.endsWith(".md"))
    .sort();
  return files.length === 0 ? null : files[files.length - 1];
}

/** 读取最新 N0 产物文本；无产物返回 null。 */
function readLatestRawInput(): string | null {
  const file = latestRawInputArtifact();
  if (file === null) {
    return null;
  }
  return readFileSync(join(N0_RAW_INPUT_DIR, file), "utf8");
}

/** 读取 artifacts/n1-draft/ 下最新的 N1 草案文件名；无产物返回 null。 */
function latestDraftArtifact(): string | null {
  mkdirSync(N1_DRAFT_DIR, { recursive: true });
  const files = readdirSync(N1_DRAFT_DIR, { encoding: "utf8" })
    .filter((name) => name.startsWith("draft-") && name.endsWith(".json"))
    .sort();
  return files.length === 0 ? null : files[files.length - 1];
}

/** 读取最新 N1 草案对象；无产物返回 null。 */
function readLatestDraft(): CreativeDraft | null {
  const file = latestDraftArtifact();
  if (file === null) {
    return null;
  }
  return JSON.parse(readFileSync(join(N1_DRAFT_DIR, file), "utf8")) as CreativeDraft;
}

/** 读取 artifacts/n2-book-config/ 下最新的 N2 书籍配置；无产物返回 null。 */
function readLatestBookConfig(): BookConfig | null {
  mkdirSync(N2_BOOK_CONFIG_DIR, { recursive: true });
  const files = readdirSync(N2_BOOK_CONFIG_DIR, { encoding: "utf8" })
    .filter((name) => name.startsWith("book-config-") && name.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    return null;
  }
  const path = join(N2_BOOK_CONFIG_DIR, files[files.length - 1]);
  return JSON.parse(readFileSync(path, "utf8")) as BookConfig;
}

/** 读取 artifacts/n3-story-bible/ 下最新的 N3 故事圣经；无产物返回 null。 */
function readLatestStoryBible(): StoryBible | null {
  mkdirSync(N3_STORY_BIBLE_DIR, { recursive: true });
  const files = readdirSync(N3_STORY_BIBLE_DIR, { encoding: "utf8" })
    .filter((name) => name.startsWith("story-bible-") && name.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    return null;
  }
  const path = join(N3_STORY_BIBLE_DIR, files[files.length - 1]);
  return JSON.parse(readFileSync(path, "utf8")) as StoryBible;
}

/** 读取 artifacts/n3-story-bible/ 下最新的 N3 书籍规则；无产物返回 null。 */
function readLatestBookRules(): BookRules | null {
  mkdirSync(N3_STORY_BIBLE_DIR, { recursive: true });
  const files = readdirSync(N3_STORY_BIBLE_DIR, { encoding: "utf8" })
    .filter((name) => name.startsWith("book-rules-") && name.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    return null;
  }
  const path = join(N3_STORY_BIBLE_DIR, files[files.length - 1]);
  return JSON.parse(readFileSync(path, "utf8")) as BookRules;
}

/** 读取 artifacts/n4-controls/ 下最新的 N4 长期创作控制；无产物返回 null。 */
function readLatestControls(): LongTermControls | null {
  mkdirSync(N4_CONTROLS_DIR, { recursive: true });
  const files = readdirSync(N4_CONTROLS_DIR, { encoding: "utf8" })
    .filter((name) => name.startsWith("controls-") && name.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    return null;
  }
  const path = join(N4_CONTROLS_DIR, files[files.length - 1]);
  return JSON.parse(readFileSync(path, "utf8")) as LongTermControls;
}

/**
 * 解析 N1 的输入文本：
 * - artifacts/n0-raw-input/ 已有产物 → 直接用最新的 md（跳过 N0，不调用模型，不落盘）；
 * - 没有产物 → 跑 N0（单次调用）扩展。
 * 返回 fromCache 标记，供调用方决定是否写 N0 文件。
 */
async function resolveRawInput(
  n0: RawInputAgent,
  initialInput: string,
): Promise<{ rawInput: string; fromCache: boolean }> {
  const existing = latestRawInputArtifact();
  if (existing !== null) {
    const path = join(N0_RAW_INPUT_DIR, existing);
    const cached = readFileSync(path, "utf8");
    console.log(`\n已存在 N0 产物：${path}\n（跳过 N0，直接作为 N1 输入；删除该文件可强制重新扩展）\n`);
    return { rawInput: cached, fromCache: true };
  }
  const rawInput = await n0.createRawInput(initialInput);
  console.log("\n【N0 扩展后的原始输入】\n" + rawInput + "\n");
  return { rawInput, fromCache: false };
}

/** 用原始输入跑 N1（--clarify 时多轮反问），返回草案。 */
async function generateDraft(n1: CreativeDraftAgent, args: CliArgs, rawInput: string): Promise<CreativeDraft> {
  if (args.clarify === true) {
    const asker = createCliAsker();
    try {
      return await n1.createDraftWithClarification(rawInput, asker.ask);
    } finally {
      asker.close();
    }
  }
  return n1.createDraft(rawInput);
}

/** N2 单跑：读最新 N1 草案 → 生成 BookConfig（纯程序，不调 LLM、不依赖模型模式）。 */
async function runN2Only(): Promise<void> {
  const draft = readLatestDraft();
  if (draft === null) {
    throw new Error("没有找到 N1 草案（artifacts/n1-draft/），请先运行 --step n1 或全链路");
  }
  const config = buildBookConfig(draft);
  console.log(`\n【N2 书籍配置】已创建书籍：${config.bookId}（${config.title}）`);
  console.log(JSON.stringify(config, null, 2));
  saveBookConfig(config);
}

/** N4 单跑：把草案创作意图整理为长期创作控制四件套（只依赖 N1 草案，与 N2/N3 并行）。 */
async function runN4Only(controls: ControlsAgent, draft: CreativeDraft, persist: boolean): Promise<LongTermControls> {
  const result = await controls.createControls(draft);
  console.log("\n【N4 长期创作控制】");
  console.log(JSON.stringify(result, null, 2));
  if (persist) {
    saveControls(result);
  }
  return result;
}

/** N4 单跑入口：读最新 N1 草案 → 长期创作控制。 */
async function runN4Step(controls: ControlsAgent, persist: boolean): Promise<void> {
  const draft = readLatestDraft();
  if (draft === null) {
    throw new Error("没有找到 N1 草案（artifacts/n1-draft/），请先运行 --step n1 或全链路");
  }
  await runN4Only(controls, draft, persist);
}

/**
 * N3 与 N4 并行执行（文档数据流：N2/N3/N4 三路并行；N3 依赖 N2 产物已在内存/落盘，N4 只依赖草案）。
 * 并行后两个节点的耗时只取较慢者，不串行等待。返回两者产物，供 N5 内存传递（memory 模式不落盘也能接续）。
 */
async function runN3N4Parallel(
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

/**
 * N5：架构师前四件 → Director 节拍板 → 五件套。
 * 优先使用内存传入的输入（全链路 memory 模式）；未传入时读 N1/N3/N4 落盘产物（--step n5 单跑）。
 */
async function runN5Only(
  architecture: ArchitectureAgent,
  persist: boolean,
  input?: { draft: CreativeDraft; storyBible: StoryBible; bookRules: BookRules; controls: LongTermControls },
): Promise<StoryArchitecture> {
  let draft: CreativeDraft;
  let storyBible: StoryBible;
  let bookRules: BookRules;
  let controls: LongTermControls;
  if (input !== undefined) {
    ({ draft, storyBible, bookRules, controls } = input);
  } else {
    const latestDraft = readLatestDraft();
    if (latestDraft === null) {
      throw new Error("没有找到 N1 草案（artifacts/n1-draft/），请先运行 --step n1 或全链路");
    }
    draft = latestDraft;
    const latestBible = readLatestStoryBible();
    if (latestBible === null) {
      throw new Error("没有找到 N3 故事圣经（artifacts/n3-story-bible/），请先运行 --step n3 或全链路");
    }
    storyBible = latestBible;
    const latestRules = readLatestBookRules();
    if (latestRules === null) {
      throw new Error("没有找到 N3 书籍规则（artifacts/n3-story-bible/），请先运行 --step n3 或全链路");
    }
    bookRules = latestRules;
    const latestControls = readLatestControls();
    if (latestControls === null) {
      throw new Error("没有找到 N4 长期创作控制（artifacts/n4-controls/），请先运行 --step n4 或全链路");
    }
    controls = latestControls;
  }
  const result = await architecture.createArchitecture({ draft, storyBible, bookRules, controls });
  console.log(`\n【N5 小说静态架构】五件套：故事框架 / 分卷规划（${result.volumeMap.length} 卷）/ 角色卡（${result.characterCards.length} 张）/ 叙事线地图（${result.threadMap.lines.length} 条线）/ 节拍板（${result.beatBoard.beats.length} 章）`);
  console.log(JSON.stringify(
    {
      bookId: result.bookId,
      title: result.title,
      storyFrame: result.storyFrame,
      volumeMap: result.volumeMap,
      characterCards: result.characterCards,
      threadMap: result.threadMap,
      beatBoardSummary: {
        chapterCount: result.beatBoard.beats.length,
        sample: result.beatBoard.beats.slice(0, 3),
      },
    },
    null,
    2,
  ));
  if (persist) {
    saveArchitecture(result);
  }
  return result;
}

/** N5 单跑入口（--step n5）：读落盘产物。 */
async function runN5Step(architecture: ArchitectureAgent, persist: boolean): Promise<void> {
  await runN5Only(architecture, persist);
}

/** 读取 artifacts/n5-architecture/ 下最新的 N5 五件套；无产物返回 null。 */
function readLatestArchitecture(): StoryArchitecture | null {
  mkdirSync(N5_ARCHITECTURE_DIR, { recursive: true });
  const files = readdirSync(N5_ARCHITECTURE_DIR, { encoding: "utf8" })
    .filter((name) => name.startsWith("architecture-") && name.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    return null;
  }
  const path = join(N5_ARCHITECTURE_DIR, files[files.length - 1]);
  return JSON.parse(readFileSync(path, "utf8")) as StoryArchitecture;
}

/**
 * N6：把 N5 五件套转成初始运行状态 State₀（六类）。
 * 优先使用内存传入的架构（全链路）；未传入时读最新 N5 产物（--step n6 单跑）。
 */
async function runN6Only(
  state0Agent: State0Agent,
  persist: boolean,
  architecture?: StoryArchitecture,
): Promise<State0> {
  let input: StoryArchitecture;
  if (architecture !== undefined) {
    input = architecture;
  } else {
    const latest = readLatestArchitecture();
    if (latest === null) {
      throw new Error("没有找到 N5 小说静态架构（artifacts/n5-architecture/），请先运行 --step n5 或全链路");
    }
    input = latest;
  }
  const result = await state0Agent.createState0(input);
  console.log(`\n【N6 State₀ 初始化运行状态】人物状态 ${result.characterStates.length} 条 / 关系状态 ${result.relationshipStates.length} 条 / 世界状态 ${result.worldState.length} 条 / 伏笔种子 ${result.hookSeeds.length} 条 / 线状态板 ${result.threadBoard.length} 条 / 进度`);
  console.log(JSON.stringify(result, null, 2));
  if (persist) {
    saveState0(result);
  }
  return result;
}

/** N6 单跑入口（--step n6）。memory 模式直接复用内存示例架构（与全链路 memory 一致，不读盘）；real 模式读落盘 N5 产物。 */
async function runN6Step(state0Agent: State0Agent, persist: boolean, memoryArchitecture?: StoryArchitecture): Promise<void> {
  await runN6Only(state0Agent, persist, memoryArchitecture);
}

/** 读取 artifacts/n6-state0/ 下最新的 N6 State₀；无产物返回 null。 */
function readLatestState0(): State0 | null {
  mkdirSync(N6_STATE0_DIR, { recursive: true });
  const files = readdirSync(N6_STATE0_DIR, { encoding: "utf8" })
    .filter((name) => name.startsWith("state0-") && name.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    return null;
  }
  const path = join(N6_STATE0_DIR, files[files.length - 1]);
  return JSON.parse(readFileSync(path, "utf8")) as State0;
}

/**
 * N7：把 N1~N6 产物序列化成书籍项目目录（纯程序，不调 LLM）。
 * 全链路时直接使用内存产物；--step n7 单跑时读取落盘产物。
 * persist=false（memory 演示）时 dry-run：生成全部文件内容但不落盘，打印目录树。
 */
async function runN7Only(
  inputs: WorkspaceInputs,
  persist: boolean,
  force: boolean,
): Promise<void> {
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

/** N7 单跑入口（--step n7）：读取全部落盘产物 → 生成书目录。 */
async function runN7Step(persist: boolean, force: boolean): Promise<void> {
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

/** 定位 N8 要处理的书目录：--book 指定 bookId，缺省取 n7-workspace 下最新书目录。 */
function resolveWorkspaceBookId(bookIdArg?: string): { bookId: string; dir: string } {
  if (bookIdArg !== undefined && bookIdArg !== "") {
    return { bookId: bookIdArg, dir: join(N7_WORKSPACE_DIR, bookIdArg) };
  }
  mkdirSync(N7_WORKSPACE_DIR, { recursive: true });
  const books = readdirSync(N7_WORKSPACE_DIR, { encoding: "utf8" })
    .filter((name) => name !== ".gitkeep" && !name.startsWith("."))
    .sort();
  if (books.length === 0) {
    throw new Error(`artifacts/n7-workspace 下没有书目录，请先运行 --step n7。也可用 --book <bookId> 指定。`);
  }
  return { bookId: books[books.length - 1], dir: join(N7_WORKSPACE_DIR, books[books.length - 1]) };
}

/**
 * N8：Book Runtime Ready（交接点，纯程序不调 LLM）。
 * ① 验收八类内容物 → ② AI 红线扫描消毒（自动替换并打印「从什么改成什么」）→ ③ 写交接凭据 ready.json。
 */
async function runN8Step(bookIdArg?: string): Promise<void> {
  const { bookId, dir } = resolveWorkspaceBookId(bookIdArg);
  if (!existsSync(dir)) {
    throw new Error(`书目录不存在：${dir}。请先运行 --step n7 生成，或检查 --book <bookId>。`);
  }
  console.log(`\n【N8 Book Runtime Ready】交接点：小说级终点 = 章节级起点`);
  console.log(`  书：${bookId} @ ${dir}\n`);

  // ① 验收八类内容物
  const verify = verifyWorkspace(dir);
  const bad = verify.checks.filter((c) => !c.ok);
  for (const c of verify.checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  }

  // ② AI 红线扫描消毒
  console.log(`\n【N8 红线消毒】扫描全部 .md/.json（排除 book_rules.md 规则定义与 story/runtime/ 运行日志）…`);
  const scan = scanAndFixRedlines(dir);
  if (scan.damaged.length > 0) {
    console.log(`  ⚠ 替换后 JSON 无法解析（已回滚，需人工处理）：${scan.damaged.join("、")}`);
  }
  if (scan.fixes.length === 0) {
    console.log("  未发现红线词，无需修改 ✓");
  } else {
    console.log(`  共 ${scan.fixes.length} 处自动替换（扫 ${scan.scannedFiles} 个文件）：`);
    for (const f of scan.fixes) {
      console.log(`    ${f.file}:${f.line}（${f.ruleId}）「${f.from}」→「${f.to}」`);
    }
  }

  // ③ 写交接凭据
  const ready = {
    bookId,
    status: verify.ok && scan.damaged.length === 0 ? "ready" : "warn",
    checkedAt: new Date().toISOString(),
    checks: verify.checks,
    redlineFixes: scan.fixes,
    note: "N9 章节级工作流以此书目录为唯一事实源；Settler 划账等运行期更新只写本目录。",
  };
  const readyPath = join(dir, "story", "runtime", "ready.json");
  mkdirSync(join(dir, "story", "runtime"), { recursive: true });
  writeFileSync(readyPath, JSON.stringify(ready, null, 2), "utf8");

  console.log(`\n交接结果：${ready.status === "ready" ? "READY ✓（可进入 N9 章节执行）" : "WARN ⚠（存在缺失/损坏，请修复后再进 N9）"}`);
  console.log(`交接凭据已写入：${readyPath}`);
}

/** N3 单跑：读最新 N1 草案 + N2 BookConfig → 架构师生成故事圣经与书籍规则。persist=false 时只打印不落盘（memory 演示）。 */
async function runN3Only(architect: ArchitectAgent, persist: boolean): Promise<{ storyBible: StoryBible; bookRules: BookRules }> {
  const draft = readLatestDraft();
  if (draft === null) {
    throw new Error("没有找到 N1 草案（artifacts/n1-draft/），请先运行 --step n1 或全链路");
  }
  const bookConfig = readLatestBookConfig();
  if (bookConfig === null) {
    throw new Error("没有找到 N2 书籍配置（artifacts/n2-book-config/），请先运行 --step n2 或全链路");
  }
  const brief = buildCreativeBrief(draft);
  console.log(`\n【创作简报】\n${brief}\n`);
  const { storyBible, bookRules } = await architect.createStoryFoundation(brief, draft, bookConfig);
  console.log(`\n【N3 故事圣经】共 ${storyBible.sections.length} 节`);
  console.log(JSON.stringify(storyBible, null, 2));
  if (persist) {
    saveStoryBible(storyBible);
  }
  console.log(
    `\n【N3 书籍规则】书特定 ${bookRules.rules.filter((r) => r.category === "story").length} 条 + AI 红线 ${bookRules.rules.filter((r) => r.category === "ai-redline").length} 条`,
  );
  console.log(JSON.stringify(bookRules, null, 2));
  if (persist) {
    saveBookRulesDoc(bookRules);
  }
  return { storyBible, bookRules };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log(USAGE);
    console.log(INPUT_GUIDE);
    return;
  }

  // N2 是纯程序节点：不依赖模型，任何模式下 --step n2 都直接执行
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
  const initialInput =
    args.file !== undefined ? readFileSync(args.file, "utf8") : (args.input ?? EXAMPLE_RAW_INPUT);

  if (!isReal) {
    console.log("（memory 模式：使用预置《隐龙》示例数据演示链路，不调用真实模型、不落盘）\n");
  } else {
    console.log("正在调用真实模型，请稍候（首次可能需要 30~90 秒）...");
  }

  if (args.step === "n0") {
    const { rawInput, fromCache } = await resolveRawInput(n0, initialInput);
    if (isReal && !fromCache) {
      saveRawInput(rawInput);
    }
    return;
  }

  if (args.step === "n1") {
    const rawInput = readLatestRawInput();
    if (rawInput === null) {
      throw new Error("没有找到 N0 产物（artifacts/n0-raw-input/），请先运行 --step n0 或全链路");
    }
    const draft = await generateDraft(n1, args, rawInput);
    console.log(JSON.stringify(draft, null, 2));
    if (isReal) {
      saveDraft(draft);
    }
    return;
  }

  if (args.step === "n3") {
    await runN3Only(architect, isReal);
    return;
  }

  if (args.step === "n4") {
    const controls = isReal ? buildRealControlsAgent() : buildMemoryControlsAgent();
    await runN4Step(controls, isReal);
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

  // 全链路：N0 → N1 → N2 →（N3 ‖ N4 并行）→ N5 → N6
  const { rawInput, fromCache } = await resolveRawInput(n0, initialInput);
  if (isReal && !fromCache) {
    saveRawInput(rawInput);
  }
  const draft = await generateDraft(n1, args, rawInput);
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
  const controls = isReal ? buildRealControlsAgent() : buildMemoryControlsAgent();
  const parallel = await runN3N4Parallel(architect, controls, draft, isReal);
  // N5：real 模式读 N3/N4 落盘产物；memory 模式直接复用并行段的返回值（避免串读旧产物）。
  // runN5Only 返回五件套，N6 直接接续，不需要二次读盘。
  const architectureResult = await runN5Only(
    architecture,
    isReal,
    isReal ? undefined : { draft, storyBible: parallel.storyBible, bookRules: parallel.bookRules, controls: parallel.controls },
  );
  // N6：memory 模式直接复用内存五件套；real 模式读落盘产物
  const state0Result = await runN6Only(state0Agent, isReal, architectureResult);
  // N7：纯程序，把 N1~N6 内存产物序列化成书目录（real 落盘；memory dry-run 预览）
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
}

main().catch((error: unknown) => {
  const message =
    error instanceof CreativeDraftError || error instanceof RawInputError || error instanceof Error
      ? error.message
      : String(error);
  console.error(`处理失败：${message}`);
  process.exitCode = 1;
});
