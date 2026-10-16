/**
 * 章节工作流驱动入口（章节级，与小说级应用入口同属 app）。
 *
 * 与 run-chapter.ts 的区别：run-chapter 是 workflow 层的调试入口，要求手动传
 * --base-url/--model/--api-key/--workspace；本入口面向正式使用——
 *  - 自动定位最新小说书目录（.fly-novel-store/<novelId>/workspace_node/），不传 --workspace；
 *  - model 复用小说级配置（.fly-novel/settings.json + 解密凭据，provider=qwen），
 *    不传 --base-url/--model/--api-key，也不读 FLY_NOVEL_* 环境变量。
 *
 * 用法（编译后，在仓库根）：
 *   pnpm run build
 *   node dist/app/run-chapters.js                     # 自动定位最新书目录，写第 1 章
 *   node dist/app/run-chapters.js --chapter 3        # 写第 3 章
 *   node dist/app/run-chapters.js --chapter 1 --to 5 # 连续写第 1~5 章
 *   node dist/app/run-chapters.js --novel-id <ID> # 指定小说
 *   node dist/app/run-chapters.js --store-dir <dir>  # 断点/正文存放目录（缺省 .fly-novel-store）
 *
 * 每章正文和断点写入 {store-dir}/{novelId}/chapter_workflow/；
 * 跨章运行时状态存为同目录的 runtime-state.json，下次运行自动恢复。
 */
import { existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ChatOpenAI } from "@langchain/openai";
import {
  AuditAgent,
  CharacterAgentManager,
  CensorAgent,
  DirectorAgent,
  WriterAgent,
} from "@fly-novel/agents";
import { createConfiguredChatOpenAI } from "./chat-openai-model";
import type { AgentGenerateInput, AgentGenerateOutput, AgentPort } from "../workflow/agent-port";
import { createJsonFileStore } from "../workflow/file-store";
import { runChapterGraph } from "../workflow/chapter_workflow";
import { buildRuntimeFromBookWorkspace } from "../novel/runtime/book-workspace";
import { ARTIFACTS_ROOT } from "../novel-flow/paths";
import { novelArtifactDirectory } from "../workflow/novel_workflow/artifacts";
import type { NovelId } from "../novel/types";
import type { WorkflowEvent } from "../workflow/types";

/** 复用小说级 model 配置：settings.json 的顶层供应商键。 */
const MODEL_PROVIDER = "deepseek";

/** 把小说级 ModelClient（ConfiguredLlmModel，settings 读+解密）适配成 workflow 的 AgentPort。 */
function createConfiguredAgentPort(model: ChatOpenAI): AgentPort {
  return {
    async generate(input: AgentGenerateInput): Promise<AgentGenerateOutput> {
      const response = await model.invoke([
        { role: "system", content: input.instruction },
        { role: "user", content: input.context },
        ]);
      const text = typeof response.content === "string"
        ? response.content.trim()
        : response.content
          .map((part) => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "")
          .join("")
          .trim();
      if (input.outputFormat === "json") {
        try {
          return { text, json: JSON.parse(text) as unknown };
        } catch {
          return { text };
        }
      }
      return { text };
    },
  };
}

/** 定位指定小说的书目录；未指定 ID 时选最近修改的新格式书目录。 */
function resolveNovelWorkspace(novelIdArg?: string): { novelId: string; dir: string } {
  const novelIds = novelIdArg === undefined
    ? existsSync(ARTIFACTS_ROOT) ? readdirSync(ARTIFACTS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name))
      .map((entry) => entry.name) : []
    : [novelIdArg];
  const candidates = novelIds.map((novelId) => ({
    novelId,
    dir: novelArtifactDirectory(ARTIFACTS_ROOT, novelId, "workspace_node"),
  })).filter(({ dir }) => existsSync(dir)).map((candidate) => ({ ...candidate, mtimeMs: statSync(candidate.dir).mtimeMs }));
  if (candidates.length === 0) throw new Error("未找到小说工作区，请确认 --novel-id");
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.dir.localeCompare(b.dir));
  const selected = candidates[0];
  return { novelId: selected.novelId, dir: selected.dir };
}

interface CliOptions {
  readonly novelId?: string;
  readonly chapter?: number;
  readonly to?: number;
  readonly storeDir?: string;
  readonly help?: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") {
      out.help = "1";
      continue;
    }
    if (key.startsWith("--") && i + 1 < argv.length) {
      out[key.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return {

    novelId: out["novel-id"],
    chapter: out.chapter === undefined ? undefined : Number(out.chapter),
    to: out.to === undefined ? undefined : Number(out.to),
    storeDir: out["store-dir"],
    help: out.help === "1",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log("用法：node dist/app/run-chapters.js [--novel-id <ID>] [--chapter N] [--to M] [--store-dir <dir>]");
    console.log("说明：自动定位最近修改的小说书目录；model 复用小说级配置（.fly-novel/settings.json，provider=qwen）；");
    console.log("      正文与断点存 {store-dir}/{novelId}/chapter_workflow/。");
    return;
  }

  const { novelId, dir: workspace } = resolveNovelWorkspace(args.novelId);
  const chapter = args.chapter ?? 1;
  const to = args.to ?? chapter;
  const storeDir = args.storeDir ?? ".fly-novel-store";
  const chapterRoot = novelArtifactDirectory(storeDir, novelId, "chapter_workflow");
  const runtimeStatePath = join(chapterRoot, "runtime-state.json");

  console.log(`书目录：${workspace}`);
  console.log(`章节：${chapter}~${to}，store：${chapterRoot}/`);

  // 专用 Agent 与通用工作流节点复用小说级模型配置。
  const [model, directorModel, writeModel] = await Promise.all([
    createConfiguredChatOpenAI(MODEL_PROVIDER, {
      timeoutMs: 480_000,
      disableThinking: true,
      temperature: 0.7,
    }),
    createConfiguredChatOpenAI(MODEL_PROVIDER, {
      timeoutMs: 480_000,
      disableThinking: true,
      temperature: 0.7,
      responseFormat: "json_object",
    }),
    createConfiguredChatOpenAI(MODEL_PROVIDER, {
      timeoutMs: 480_000,
      disableThinking: true,
      temperature: 0.7,
      maxTokens: 8000,
    }),
  ]);
  const agent = createConfiguredAgentPort(model);
  const directorAgent = new DirectorAgent({ model: directorModel });
  const writerAgent = new WriterAgent({ model: writeModel });
  const auditAgent = new AuditAgent({ model });
  const censorAgent = new CensorAgent({ model });
  const runtime = buildRuntimeFromBookWorkspace(workspace);
  const store = createJsonFileStore({ dir: chapterRoot });
  const characterAgents = new CharacterAgentManager({
    model,
    novelId,
    branchId: "main",
  });

  // 恢复跨章运行时状态（账本/真相/时钟/角色状态，上一章结束落盘）
  try {
    const raw = readFileSync(runtimeStatePath, "utf8");
    runtime.restore(JSON.parse(raw));
    console.log(`恢复运行时状态：${runtimeStatePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`运行时状态读取失败（${error instanceof Error ? error.message : String(error)}），使用书目录初始状态继续`);
    }
  }

  const notify = (event: WorkflowEvent): void => {
    switch (event.type) {
      case "step-completed":
        console.log(`  [step] ${event.step} 完成（status=${event.state.status}）`);
        break;
      case "retrying":
        console.log(`  [retry] ${event.from} → ${event.to}（第 ${event.attempt} 次）`);
        break;
      case "suspended":
        console.log(`  [suspend] ${event.step}：${event.reason}`);
        break;
      case "failed":
        console.error(`  [fail] ${event.step}：${event.reason}`);
        break;
      case "completed":
        console.log(`  [done] 章 ${event.chapter} 完成（${event.state.status}）`);
        break;
    }
  };

  const runOptions = {
    agent,
    directorAgent,
    writerAgent,
    auditAgent,
    censorAgent,
    characterAgents,
    runtime,
    store,
    maxRetries: 4,
    notify,
  };

  const novel: NovelId = novelId as NovelId;
  try {
    for (let ch = chapter; ch <= to; ch += 1) {
      console.log(`\n[章节 ${ch}/${to}] 运行章节流：novel=${novelId}`);
      const result = await runChapterGraph(novel, ch, runOptions);
      console.log(`结果：${result.kind}${result.kind === "suspended" || result.kind === "failed" ? `（${result.reason}）` : ""}`);

      // 只要有正文产物就导出草稿
      const persisted = await store.load(novel, ch);
      const draft = persisted?.artifacts?.["write"];
      if (typeof draft === "string" && draft !== "") {
        const draftPath = join(chapterRoot, `${ch}.md`);
        mkdirSync(dirname(draftPath), { recursive: true });
        writeFileSync(draftPath, `# 第 ${ch} 章\n\n${draft}`, "utf8");
        console.log(`正文草稿：${draftPath}`);
      }

      // 挂起/失败/无效说明后续章节依赖本章状态，先停下，由人工介入后重跑该章
      if (result.kind === "failed" || result.kind === "suspended" || result.kind === "invalid") {
        console.log(`章节 ${ch} 未完成（${result.kind}），停止继续写后续章节；处理后重跑 --chapter ${ch}。`);
        break;
      }
    }

    // 落盘运行时状态（下一章/下次运行从此继续）
    try {
      mkdirSync(dirname(runtimeStatePath), { recursive: true });
      writeFileSync(runtimeStatePath, JSON.stringify(runtime.snapshot(), null, 2), "utf8");
      console.log(`\n运行时状态已保存：${runtimeStatePath}`);
    } catch (error) {
      console.warn(`运行时状态落盘失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    characterAgents.clear();
  }
}

main().catch((error) => {
  console.error(`驱动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
