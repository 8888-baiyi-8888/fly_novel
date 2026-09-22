import { readFileSync, writeFileSync } from "node:fs";
import { MemoryModel } from "../harness/adapters/models/memory-model";
import { CreativeDraftAgent, CreativeDraftError } from "../novel/draft/creative-draft-agent";
import { EXAMPLE_DRAFT_JSON, EXAMPLE_RAW_INPUT } from "../novel/draft/example";
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
 * 组装「创意草案整理」应用 —— 真实模型版（当前使用 qwen）。
 * 走项目正式 LLM 机制：src/config 读取并解密凭据（settings.json + .credentials.json + .encryption-key），
 * src/llm 适配器路由（OpenAICompatibleAdapter，由 src/app/llm-adapters.ts 注册）。
 *
 * 原实现（.env 明文 key + harness 自建 OpenAICompatibleModel）已弃用，见 git 历史；按需可回切：
 *   const apiKey = process.env.FLY_NOVEL_API_KEY; ...
 */
export function buildRealCreativeDraftAgent(): CreativeDraftAgent {
  const model = new ConfiguredLlmModel({ provider: "qwen", timeoutMs: 180_000 });
  return new CreativeDraftAgent({ model });
}

interface CliArgs {
  input?: string;
  file?: string;
  model?: "memory" | "real";
  output?: string;
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
    } else if (token === "--output" && value !== undefined) {
      args.output = value;
      i += 1;
    } else if (token === "--help") {
      args.help = true;
    } else {
      throw new Error(
        `未知参数：${token}（支持 --input <文本>、--file <路径>、--model memory|real、--output <路径>、--help）`,
      );
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    console.log(USAGE);
    console.log(INPUT_GUIDE);
    return;
  }

  const rawInput =
    args.file !== undefined ? readFileSync(args.file, "utf8") : (args.input ?? EXAMPLE_RAW_INPUT);

  const agent = args.model === "real" ? buildRealCreativeDraftAgent() : buildCreativeDraftAgent();
  if (args.model === "real") {
    console.log("正在调用真实模型，请稍候（首次可能需要 30~90 秒）...");
  }
  const draft = await agent.createDraft(rawInput);
  const json = JSON.stringify(draft, null, 2);
  console.log(json);
  if (args.output !== undefined) {
    writeFileSync(args.output, json, "utf8");
    console.log(`\n已保存草案到：${args.output}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof CreativeDraftError || error instanceof Error ? error.message : String(error);
  console.error(`创意草案整理失败：${message}`);
  process.exitCode = 1;
});
