import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
import { N0_RAW_INPUT_DIR, N1_DRAFT_DIR, N2_BOOK_CONFIG_DIR, N3_STORY_BIBLE_DIR } from "../config/paths";
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

type Step = "n0" | "n1" | "n2" | "n3";

interface CliArgs {
  input?: string;
  file?: string;
  model?: "memory" | "real";
  clarify?: boolean;
  step?: Step;
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
      if (value !== "n0" && value !== "n1" && value !== "n2" && value !== "n3") {
        throw new Error(`--step 只支持 n0、n1、n2 或 n3，收到：${value}`);
      }
      args.step = value;
      i += 1;
    } else if (token === "--clarify") {
      args.clarify = true;
    } else if (token === "--help") {
      args.help = true;
    } else {
      throw new Error(
        `未知参数：${token}（支持 --input <文本>、--file <路径>、--model memory|real、--step n0|n1|n2|n3、--clarify、--help）`,
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

/** N3 单跑：读最新 N1 草案 + N2 BookConfig → 架构师生成故事圣经与书籍规则。persist=false 时只打印不落盘（memory 演示）。 */
async function runN3Only(architect: ArchitectAgent, persist: boolean): Promise<void> {
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

  // 全链路：N0 → N1 → N2 → N3
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
  await runN3Only(architect, isReal);
}

main().catch((error: unknown) => {
  const message =
    error instanceof CreativeDraftError || error instanceof RawInputError || error instanceof Error
      ? error.message
      : String(error);
  console.error(`处理失败：${message}`);
  process.exitCode = 1;
});
